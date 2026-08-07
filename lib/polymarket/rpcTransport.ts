/**
 * 链上 RPC 传输层:代理优先 + 直连兜底(2026-08-07)。
 *
 * 背景 —— run-cron.sh 把全部 RPC 域名放进 NO_PROXY 强制直连,理由是当时实测
 * "drpc 走 Clash 会 TLS 失败",并且要让 chain-watch 的链上告警独立于 Clash 存活
 * (heartbeat 的 proxy-gamma 告警文案至今这么写)。2026-08-07 实测推翻了前半条,
 * 也量化了这个选择的代价:
 *
 *   路径          eth_blockNumber 成功率    平均延迟
 *   直连(出口 CN)  67%(并发)/73%(串行)      1.9–5.6 s
 *   代理(出口 JP)  100%(96/96)              116–461 ms
 *
 * 失败 100% 是超时(TimeoutError/ETIMEDOUT),curl 逐个直测四家全部 http=200 ——
 * 端点是健康的,烂的是国际出口链路,且随高峰时段起伏(UTC 06/07/13/14 最差,
 * rpc-quorum 非 ok 占比 08-02 的 27% 一路涨到 08-06 的 48%)。
 *
 * 但"全切代理"会把链上告警绑死在 Clash 这个单点上,那正是当初直连要规避的。
 * 所以这里两条路都保留:每个端点先走代理,失败再落直连,冗余从 4 路变 8 路。
 *
 * 为什么自建传输而不是设 HTTPS_PROXY 让 fetch 自己走:Node 的 env-proxy
 * (NODE_USE_ENV_PROXY)是进程级全局开关,配合 NO_PROXY 只能"整个域名要么走要么
 * 不走",无法按次切换;per-request 要 undici 的 ProxyAgent,而本仓库没有 undici
 * 依赖(只有 undici-types),Node 也不导出它。手写 CONNECT 隧道换来的额外好处是
 * 路由完全由本模块决定,不再受 NO_PROXY 配置摆布 —— run-cron.sh 无需改动,
 * 其余走代理的模块(gamma/clob)行为也完全不变。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";

export type RpcRoute = "proxy" | "direct";

export interface RpcPostOptions {
  /** 该端点的**总**预算(ms),代理与直连两条路共享,不是各给一份。
   *
   * 语义刻意这么定:调用方(尤其 oracleState.ethCall)按"每 URL 至多 N 秒"
   * 反算整轮预算,若两条路各拿满 N 秒,单端点最坏耗时会翻倍、直接击穿
   * chain-watch 的 170s SIGTERM。共享预算下,接代理前后各调用点的最坏
   * 墙钟与改造前完全一致 —— 多出来的只是冗余,不是时间。 */
  timeoutMs?: number;
  /** 只走这条路 —— 探针要分别标定两条路时用。默认两条都试。 */
  only?: RpcRoute;
}

export interface RpcPostResult {
  /** 实际走通的路径。 */
  route: RpcRoute;
  status: number;
  body: string;
}

/** 单端点默认总预算。与改造前各调用点写死的 15s 对齐 —— 接入代理不得让任何
 * 调用点的最坏墙钟变长。 */
const DEFAULT_TOTAL_MS = 15_000;
/** 总预算里分给代理的上限。代理正常时 RTT 116–461ms(2026-08-07 实测),6s 是
 * 13 倍余量;剩下的全留给直连兜底。这个值同时决定 Clash 挂掉时每个端点要
 * 白等多久才落直连 —— 熔断是第二道保险,见 PROXY_CIRCUIT_TRIP。 */
const PROXY_SHARE_MS = 6_000;
/** 代理最多只能吃掉总预算的这个比例。绝对值封顶(PROXY_SHARE_MS)在预算本就
 * 小于它时形同虚设 —— 代理会吃光全部预算,直连兜底一点不剩,"双路冗余"退化
 * 成"只有代理"。这正是 Clash 半死(隧道建得起来但不通)时最需要兜底的时刻。 */
const PROXY_BUDGET_FRACTION = 0.4;
/** 低于此值不值得再发起一次尝试(TLS 握手都不够)。 */
const MIN_ATTEMPT_MS = 300;

/** 代理连续失败多少次后短路。Clash 死掉时,若每个端点都老实等满 8s 再落直连,
 * 4 个端点就是 32s 的净损耗 —— chain-watch 整个 tick 预算才 170s。 */
const PROXY_CIRCUIT_TRIP = 2;
/** 熔断冷却:过后放一次半开探测。release-sniper/release-watch 是 12h 常驻进程,
 * 没有冷却的话 Clash 恢复了也要等到进程重启才用得上代理。 */
const PROXY_CIRCUIT_COOLDOWN_MS = 60_000;

interface ProxyHealth {
  consecutiveFailures: number;
  /** 熔断到期时间戳;0 = 未熔断。 */
  openUntil: number;
}

const proxyHealth: ProxyHealth = { consecutiveFailures: 0, openUntil: 0 };

/** 测试钩子 —— 进程级状态在单测之间必须可清。 */
export function resetProxyHealth(): void {
  proxyHealth.consecutiveFailures = 0;
  proxyHealth.openUntil = 0;
}

export function proxyHealthSnapshot(): Readonly<ProxyHealth> {
  return { ...proxyHealth };
}

/** 代理地址来自 HTTPS_PROXY/HTTP_PROXY(run-cron.sh 按 WSL 网关运行时算出)。
 * 刻意不看 NO_PROXY:那份名单是给 Node 内置 env-proxy 用的,而 RPC 域名恰恰
 * 全在里面 —— 照着读就等于永远走不了代理,本模块也就没有意义了。 */
export function proxyEndpoint(): { host: string; port: number } | null {
  const raw =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    "";
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (!u.hostname || !Number.isFinite(port)) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function proxyCircuitOpen(now: number): boolean {
  return proxyHealth.openUntil > now;
}

function noteProxyOutcome(ok: boolean, now: number): void {
  if (ok) {
    proxyHealth.consecutiveFailures = 0;
    proxyHealth.openUntil = 0;
    return;
  }
  proxyHealth.consecutiveFailures += 1;
  if (proxyHealth.consecutiveFailures >= PROXY_CIRCUIT_TRIP) {
    proxyHealth.openUntil = now + PROXY_CIRCUIT_COOLDOWN_MS;
  }
}

/** 经 HTTP CONNECT 建隧道。Clash 的 mixed 端口支持 CONNECT(curl -x 对 https
 * 目标走的就是这条路,实测通)。 */
function openTunnel(
  proxy: { host: string; port: number },
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      // Host 头对部分代理实现是必需的;Clash 不校验但给上无害。
      headers: { host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.on("connect", (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        // 代理明确拒绝(407 需认证 / 403 规则拦截)。socket 必须销毁,
        // 否则半开连接会攒住 —— 这正是笔记里 WebFetch 悬挂的同一类病根。
        socket.destroy();
        fail(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      settled = true;
      resolve(socket);
    });
    req.on("timeout", () => fail(new Error("proxy CONNECT timeout")));
    req.on("error", (err) => fail(err));
    req.end();
  });
}

/** 发一次 POST,拿完整响应体。socket 由 createConnection 决定是隧道还是直连,
 * 请求层完全一致。 */
function postOnce(
  url: string,
  payload: string,
  timeoutMs: number,
  route: RpcRoute
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`bad RPC url: ${url}`));
      return;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      reject(new Error(`unsupported RPC protocol: ${target.protocol}`));
      return;
    }

    const isTls = target.protocol === "https:";
    const port = Number(target.port || (isTls ? 443 : 80));
    const proxy = route === "proxy" ? proxyEndpoint() : null;
    if (route === "proxy" && !proxy) {
      reject(new Error("no proxy configured"));
      return;
    }

    let settled = false;
    let tunnelSocket: Socket | null = null;
    // 整条链路(连接+TLS+首字节+响应体)的总闸。node 的 request timeout 只管
    // socket 空闲,盖不住慢速滴流的响应体 —— 那正是 08-07 实测里 fetch 卡到
    // 10s 超时的形态。
    const overallTimer = setTimeout(() => {
      fail(new Error(`${route} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(overallTimer);
      tunnelSocket?.destroy();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const done = (status: number, body: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      resolve({ status, body });
    };

    const send = (createConnection?: RequestOptions["createConnection"]) => {
      const opts: RequestOptions = {
        method: "POST",
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          host: target.host,
        },
        ...(createConnection ? { createConnection } : {}),
      };
      const req = (isTls ? httpsRequest : httpRequest)(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
        res.on("error", (err) => fail(err));
      });
      req.on("error", (err) => fail(err));
      req.write(payload);
      req.end();
    };

    if (!proxy) {
      send();
      return;
    }

    openTunnel(proxy, target.hostname, port, timeoutMs)
      .then((socket) => {
        if (settled) {
          socket.destroy();
          return;
        }
        tunnelSocket = socket;
        socket.on("error", (err) => fail(err));
        if (!isTls) {
          // 明文目标:隧道 socket 直接用。
          send(() => socket);
          return;
        }
        // servername 必须显式给 —— 隧道 socket 上没有主机名信息,缺了它
        // SNI 为空,多数 CDN 直接握手失败。
        send(() =>
          tlsConnect({ socket, servername: target.hostname })
        );
      })
      .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * 向单个 RPC 端点 POST 一段 JSON,代理优先、直连兜底。
 *
 * 只负责传输 —— HTTP 状态与 JSON-RPC 信封由调用方判读,因为各调用点的判据
 * 不同(探针要把 "200 包着 error" 也算死,业务侧要区分 error.message)。
 */
export async function rpcPostRaw(
  url: string,
  payload: string,
  opts: RpcPostOptions = {}
): Promise<RpcPostResult> {
  const only = opts.only;
  const total = Math.max(0, opts.timeoutMs ?? DEFAULT_TOTAL_MS);
  const deadline = Date.now() + total;
  const errors: string[] = [];

  const wantProxy = only !== "direct" && proxyEndpoint() != null;
  const wantDirect = only !== "proxy";

  if (wantProxy && (only === "proxy" || !proxyCircuitOpen(Date.now()))) {
    // 独占整条路时代理可以吃满预算;两条路都要跑时取"绝对上限"与"预算占比"
    // 的较小者 —— 代理慢到 6s 已属病态,再等下去不如换直连试,而预算本身很小时
    // 还必须按比例让出直连的那一份。
    const share =
      only === "proxy"
        ? total
        : Math.min(PROXY_SHARE_MS, Math.floor(total * PROXY_BUDGET_FRACTION));
    if (share >= MIN_ATTEMPT_MS) {
      try {
        const res = await postOnce(url, payload, share, "proxy");
        noteProxyOutcome(true, Date.now());
        return { route: "proxy", ...res };
      } catch (err) {
        noteProxyOutcome(false, Date.now());
        errors.push(`proxy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (wantProxy) {
    errors.push("proxy: circuit open (skipped)");
  }

  if (wantDirect) {
    const remaining = deadline - Date.now();
    if (remaining >= MIN_ATTEMPT_MS) {
      try {
        const res = await postOnce(url, payload, remaining, "direct");
        return { route: "direct", ...res };
      } catch (err) {
        errors.push(`direct: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      errors.push(`direct: budget exhausted (${Math.max(0, remaining)}ms left)`);
    }
  }

  throw new Error(errors.join("; ") || "no route attempted");
}

/**
 * JSON-RPC 便捷封装:发一次调用,解信封,error / result 缺失即抛。
 * 业务侧(chain-watch / onchainEvents / oracleState)的三份重复实现共用这里。
 */
export async function rpcPostJson<T>(
  url: string,
  method: string,
  params: unknown[],
  opts: RpcPostOptions = {}
): Promise<T> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await rpcPostRaw(url, payload, opts);
  let json: { result?: T; error?: { message?: string } };
  try {
    json = JSON.parse(res.body) as { result?: T; error?: { message?: string } };
  } catch {
    // 429/5xx 常常回 HTML 或纯文本。带上状态码,否则日志里只剩一句
    // "Unexpected token <",完全无法区分限流和端点挂掉。
    throw new Error(`HTTP ${res.status} non-JSON body via ${res.route}: ${res.body.slice(0, 120)}`);
  }
  if (json.error || json.result === undefined) {
    throw new Error(json.error?.message ?? `empty ${method} result`);
  }
  return json.result;
}
