/**
 * RPC 传输层(代理优先 + 直连兜底)回归,2026-08-07。
 *
 * 由来:sufe 的 RPC 全部经 run-cron.sh 的 NO_PROXY 强制直连,而直连出口在 CN。
 * 08-07 实测 —— 直连成功率 67–73%、平均 1.9–5.6s,走代理(JP)96/96 且
 * 116–461ms;失败 100% 是超时,curl 逐个直测四家全部 http=200,即端点健康、
 * 烂的是国际出口链路。全切代理又会把链上告警绑死在 Clash 单点上(那正是当初
 * 直连要规避的),故两条路都留。
 *
 * 本文件起真实的本地 HTTP 服务:一个假 RPC、一个假 CONNECT 代理。不打外网,
 * 端口全部由内核分配(:0),因此可并行、可离线跑。之所以不 mock fetch:被测
 * 对象恰恰是"CONNECT 隧道建得起来吗",mock 掉传输就等于没测。
 *
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  rpcPostRaw,
  rpcPostJson,
  proxyEndpoint,
  resetProxyHealth,
  proxyHealthSnapshot,
} from "../lib/polymarket/rpcTransport";

// ── 假 RPC ──────────────────────────────────────────────────────────────
/** 记录每次请求走的是哪条路 —— 代理路径会带上 via-proxy 标记(由假代理注入)。 */
let rpcHits: Array<{ viaProxy: boolean }> = [];
/** 下一次响应的行为,逐用例改写。 */
let rpcBehavior: "ok" | "rpcError" | "html" | "hang" = "ok";
let rpcServer: http.Server;
let rpcPort = 0;

/** 假 CONNECT 代理。行为可切:正常隧道 / 拒绝 / 黑洞(建立后不回应)。 */
let proxyBehavior: "ok" | "refuse" | "blackhole" = "ok";
let proxyServer: http.Server;
let proxyPort = 0;
let proxyConnects = 0;

const rpcUrl = () => `http://127.0.0.1:${rpcPort}/`;

before(async () => {
  rpcServer = http.createServer((req, res) => {
    rpcHits.push({ viaProxy: req.headers["x-via-proxy"] === "1" });
    if (rpcBehavior === "hang") return; // 永不响应 —— 测总闸
    if (rpcBehavior === "html") {
      res.writeHead(429, { "content-type": "text/html" });
      res.end("<html>rate limited</html>");
      return;
    }
    const body =
      rpcBehavior === "rpcError"
        ? { jsonrpc: "2.0", id: 1, error: { message: "quota exceeded" } }
        : { jsonrpc: "2.0", id: 1, result: "0x1234" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => rpcServer.listen(0, "127.0.0.1", r));
  rpcPort = (rpcServer.address() as AddressInfo).port;

  proxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxyServer.on("connect", (req, clientSocket) => {
    proxyConnects += 1;
    if (proxyBehavior === "refuse") {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (proxyBehavior === "blackhole") {
      // 隧道"建成"但对端永不通 —— Clash 半死时的真实形态,也是最难判的一种。
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      return;
    }
    const [host, portRaw] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portRaw), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // 打标:让假 RPC 能分辨这条请求是从隧道进来的。注入到首个数据块的
      // 请求头里 —— 隧道是字节流,这里只需在明文 HTTP 上做一次简单改写。
      let tagged = false;
      clientSocket.on("data", (chunk) => {
        if (!tagged) {
          tagged = true;
          upstream.write(chunk.toString("utf8").replace("\r\n\r\n", "\r\nx-via-proxy: 1\r\n\r\n"));
          return;
        }
        upstream.write(chunk);
      });
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

after(async () => {
  // closeAllConnections 不能省:blackhole/hang 两个用例刻意留下了永不结束的
  // 连接,而 server.close() 只停止接受新连接、并等现役连接自己收尾 —— 回调
  // 因此永不触发,整个测试进程挂死(第一版就是这么挂的,且一行输出都没有)。
  rpcServer.closeAllConnections();
  proxyServer.closeAllConnections();
  await new Promise<void>((r) => rpcServer.close(() => r()));
  await new Promise<void>((r) => proxyServer.close(() => r()));
});

beforeEach(() => {
  rpcHits = [];
  rpcBehavior = "ok";
  proxyBehavior = "ok";
  proxyConnects = 0;
  resetProxyHealth();
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
});

// ── proxyEndpoint 解析 ──────────────────────────────────────────────────
test("proxyEndpoint: 解析带/不带 scheme 的地址,无配置返回 null", () => {
  process.env.HTTPS_PROXY = "http://10.0.0.1:7897";
  assert.deepEqual(proxyEndpoint(), { host: "10.0.0.1", port: 7897 });

  // run-cron.sh 拼的是带 scheme 的;裸 host:port 也得认(手动导出时常见)。
  process.env.HTTPS_PROXY = "172.29.64.1:7897";
  assert.deepEqual(proxyEndpoint(), { host: "172.29.64.1", port: 7897 });

  delete process.env.HTTPS_PROXY;
  assert.equal(proxyEndpoint(), null, "未配代理必须返回 null,否则会误走隧道");
});

test("proxyEndpoint: 刻意无视 NO_PROXY", () => {
  // 关键设计点 —— RPC 域名恰恰全在 run-cron.sh 的 NO_PROXY 名单里。照着读
  // 就等于永远走不了代理,本模块也就没有意义了。
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  assert.notEqual(proxyEndpoint(), null);
  delete process.env.NO_PROXY;
});

// ── 路由选择 ────────────────────────────────────────────────────────────
test("代理可用时走代理", async () => {
  const res = await rpcPostRaw(rpcUrl(), JSON.stringify({ jsonrpc: "2.0", id: 1 }));
  assert.equal(res.route, "proxy");
  assert.equal(res.status, 200);
  assert.equal(rpcHits.length, 1);
  assert.equal(rpcHits[0].viaProxy, true, "请求必须真的经过 CONNECT 隧道");
});

test("代理拒绝(403)时落直连", async () => {
  proxyBehavior = "refuse";
  const res = await rpcPostRaw(rpcUrl(), JSON.stringify({ jsonrpc: "2.0", id: 1 }));
  assert.equal(res.route, "direct");
  assert.equal(res.status, 200);
  assert.equal(proxyConnects, 1, "代理必须被试过一次");
  assert.equal(rpcHits.at(-1)?.viaProxy, false);
});

test("代理黑洞(隧道建成但不通)时落直连,且不超总预算", async () => {
  // 回归:第一版让代理吃 min(PROXY_SHARE_MS, total),预算小于 6s 时代理就
  // 吃光了全部额度,直连只剩 "budget exhausted (0ms left)" —— 双路冗余在
  // 最需要兜底的时刻(Clash 半死)退化成只有代理。现按占比让出直连的一份。
  proxyBehavior = "blackhole";
  const t0 = Date.now();
  const res = await rpcPostRaw(rpcUrl(), JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
    timeoutMs: 3_000,
  });
  const ms = Date.now() - t0;
  assert.equal(res.route, "direct", "代理黑洞时必须落直连,不能整轮失败");
  // 总额共享是硬约束:两条路各拿满会击穿 chain-watch 的 170s SIGTERM。
  assert.ok(ms < 3_500, `总耗时 ${ms}ms 应受 timeoutMs 约束`);
});

test("未配代理时直接走直连", async () => {
  delete process.env.HTTPS_PROXY;
  const res = await rpcPostRaw(rpcUrl(), JSON.stringify({ jsonrpc: "2.0", id: 1 }));
  assert.equal(res.route, "direct");
  assert.equal(proxyConnects, 0);
});

test("only 选项:分别标定两条路(heartbeat 探针靠它区分 Clash 死还是出口烂)", async () => {
  const viaProxy = await rpcPostRaw(rpcUrl(), "{}", { only: "proxy" });
  assert.equal(viaProxy.route, "proxy");

  const viaDirect = await rpcPostRaw(rpcUrl(), "{}", { only: "direct" });
  assert.equal(viaDirect.route, "direct");

  // only:"proxy" 在代理死时必须抛,绝不能偷偷落直连 —— 否则探针会把
  // "代理 4/4" 报成绿的,而实际一条隧道都没通。
  proxyBehavior = "refuse";
  await assert.rejects(() => rpcPostRaw(rpcUrl(), "{}", { only: "proxy" }));
});

// ── 熔断 ────────────────────────────────────────────────────────────────
test("代理连续失败达阈值后熔断,后续请求直接走直连", async () => {
  proxyBehavior = "refuse";
  await rpcPostRaw(rpcUrl(), "{}");
  await rpcPostRaw(rpcUrl(), "{}");
  assert.equal(proxyConnects, 2, "熔断前每次都该试代理");
  assert.ok(proxyHealthSnapshot().openUntil > Date.now(), "连续 2 次失败应触发熔断");

  // 熔断后:Clash 整个挂掉时,若每个端点都老实等满代理超时,4 个端点就是
  // 一大截净损耗 —— chain-watch 整个 tick 预算才 170s。
  const res = await rpcPostRaw(rpcUrl(), "{}");
  assert.equal(res.route, "direct");
  assert.equal(proxyConnects, 2, "熔断期内不得再碰代理");
});

test("代理成功即清零失败计数", async () => {
  proxyBehavior = "refuse";
  await rpcPostRaw(rpcUrl(), "{}");
  assert.equal(proxyHealthSnapshot().consecutiveFailures, 1);

  proxyBehavior = "ok";
  await rpcPostRaw(rpcUrl(), "{}");
  assert.equal(proxyHealthSnapshot().consecutiveFailures, 0, "一次成功应清零,避免误判累积");
  assert.equal(proxyHealthSnapshot().openUntil, 0);
});

test("only:'proxy' 无视熔断 —— 探针必须能测到真实状态", async () => {
  proxyBehavior = "refuse";
  await rpcPostRaw(rpcUrl(), "{}");
  await rpcPostRaw(rpcUrl(), "{}");
  assert.ok(proxyHealthSnapshot().openUntil > Date.now());

  proxyBehavior = "ok";
  const before = proxyConnects;
  const res = await rpcPostRaw(rpcUrl(), "{}", { only: "proxy" });
  assert.equal(res.route, "proxy");
  assert.ok(proxyConnects > before, "熔断期内探针仍须实测,否则日报会一直报代理死");
});

// ── JSON-RPC 信封 ───────────────────────────────────────────────────────
test("rpcPostJson: 解出 result", async () => {
  const out = await rpcPostJson<string>(rpcUrl(), "eth_blockNumber", []);
  assert.equal(out, "0x1234");
});

test("rpcPostJson: 200 包着 error 也算失败", async () => {
  // 1rpc 配额耗尽就是这个形态 —— 按 HTTP 状态判活会把它涂绿。
  rpcBehavior = "rpcError";
  await assert.rejects(
    () => rpcPostJson(rpcUrl(), "eth_blockNumber", []),
    /quota exceeded/
  );
});

test("rpcPostJson: 非 JSON 响应体带上状态码", async () => {
  // 429/5xx 常回 HTML。只抛 "Unexpected token <" 的话,日志里完全无法区分
  // 限流和端点挂掉。
  rpcBehavior = "html";
  await assert.rejects(
    () => rpcPostJson(rpcUrl(), "eth_blockNumber", []),
    /HTTP 429 non-JSON/
  );
});

test("总闸覆盖响应体读取(慢速滴流不得挂到 undici 默认 300s)", async () => {
  rpcBehavior = "hang";
  const t0 = Date.now();
  await assert.rejects(() => rpcPostRaw(rpcUrl(), "{}", { timeoutMs: 1_200 }));
  const ms = Date.now() - t0;
  assert.ok(ms < 2_500, `应在预算内失败,实际 ${ms}ms`);
});
