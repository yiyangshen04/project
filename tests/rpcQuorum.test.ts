import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRpcRouteState,
  summarizeRpcQuorum,
  type RpcEndpointStates,
} from "../lib/polymarket/rpcQuorum";

const OK_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x575d06f" });

test("classify:正常读数 = ok", () => {
  assert.equal(classifyRpcRouteState(200, OK_BODY), "ok");
});

test("classify:429 一律 throttled —— 对端回了应答就证明链路通", () => {
  // 正文可能是 HTML/纯文本/空,判据不能依赖正文可解析。
  assert.equal(classifyRpcRouteState(429, ""), "throttled");
  assert.equal(classifyRpcRouteState(429, "<html>Too Many Requests</html>"), "throttled");
});

test("classify:200 包着 JSON-RPC 配额 error = throttled,不是死", () => {
  // 这正是 1rpc.io 额度耗尽的形态。改动前它与端点故障同色,是 `死:1rpc.io` 的来源之一。
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32005, message: "daily request quota exceeded" },
  });
  assert.equal(classifyRpcRouteState(200, body), "throttled");
});

test("classify:200 包着**非**配额 error 仍判不可达 —— 不许把真故障涂绿", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "header not found" },
  });
  assert.equal(classifyRpcRouteState(200, body), "unreachable");
});

test("classify:403 tenant disabled 是真失效,不能当限流", () => {
  // polygon-rpc.com 现况的真实正文。从严判据的核心用例:
  // 若把所有 4xx 都算 throttled,一个被关停的端点会永远显示"链路正常"。
  const body = JSON.stringify({
    error: "message: API key disabled, reason: tenant disabled, json-rpc code: -32051, rest code: 403",
  });
  assert.equal(classifyRpcRouteState(403, body), "unreachable");
});

test("classify:403 但正文自称限流 = throttled", () => {
  assert.equal(classifyRpcRouteState(403, "rate limit exceeded for this IP"), "throttled");
});

test("classify:2xx 非 JSON 挡板页按正文关键词兜底", () => {
  assert.equal(classifyRpcRouteState(200, "<html>Too many requests</html>"), "throttled");
  assert.equal(classifyRpcRouteState(200, "<html>Bad Gateway</html>"), "unreachable");
});

const ep = (host: string, proxy: RpcEndpointStates["proxy"], direct: RpcEndpointStates["direct"]) =>
  ({ host, proxy, direct }) satisfies RpcEndpointStates;

test("summarize:被限流的端点算**可达**、不算死 —— 这是本次改动的核心", () => {
  // 生产实况:前三路健康,1rpc.io 两条路都被配额闸挡住。
  const q = summarizeRpcQuorum([
    ep("polygon-bor-rpc.publicnode.com", "ok", "ok"),
    ep("polygon.drpc.org", "ok", "ok"),
    ep("gateway.tenderly.co", "ok", "ok"),
    ep("1rpc.io", "throttled", "throttled"),
  ]);
  assert.equal(q.alive, 4, "链路可达 4 路");
  assert.deepEqual(q.dead, [], "配额拒绝不得进死亡名单");
  assert.deepEqual(q.throttled, ["1rpc.io"], "但必须单独可见,不能悄悄涂绿");
  assert.equal(q.viaProxy, 4);
  assert.equal(q.usableProxy, 3, "可用读数仍是 3 —— 信息一个字都不能丢");
  assert.equal(q.viaDirect, 4);
  assert.equal(q.usableDirect, 3);
});

test("summarize:真正两路皆不可达才进 dead", () => {
  const q = summarizeRpcQuorum([
    ep("a.example", "ok", "unreachable"),
    ep("b.example", "unreachable", "unreachable"),
  ]);
  assert.equal(q.alive, 1);
  assert.deepEqual(q.dead, ["b.example"]);
  assert.deepEqual(q.throttled, []);
});

test("summarize:一路限流一路可用 → 不进 throttled 名单(拿到读数了)", () => {
  const q = summarizeRpcQuorum([ep("a.example", "throttled", "ok")]);
  assert.deepEqual(q.throttled, [], "有任一路取到读数就不该报限流");
  assert.equal(q.alive, 1);
  assert.equal(q.viaProxy, 1, "限流也算链路可达");
  assert.equal(q.usableProxy, 0);
  assert.equal(q.usableDirect, 1);
});

test("summarize:Clash 死了 vs 国际出口烂了 —— 双路标定必须仍能区分", () => {
  const clashDead = summarizeRpcQuorum([
    ep("a.example", "unreachable", "ok"),
    ep("b.example", "unreachable", "ok"),
  ]);
  assert.equal(clashDead.viaProxy, 0);
  assert.equal(clashDead.viaDirect, 2);

  const egressDead = summarizeRpcQuorum([
    ep("a.example", "ok", "unreachable"),
    ep("b.example", "ok", "unreachable"),
  ]);
  assert.equal(egressDead.viaProxy, 2);
  assert.equal(egressDead.viaDirect, 0);
  // 两种灾难的 alive 相同,只有分路读数能把它们分开 —— 这正是双路标定的存在理由,
  // 所以"代理成功就跳过直连"那种省事写法绝不能采用。
  assert.equal(clashDead.alive, egressDead.alive);
});

test("summarize:全限流也不触发 alive<2 的告警,但全不可达要触发", () => {
  const allThrottled = summarizeRpcQuorum([
    ep("a.example", "throttled", "throttled"),
    ep("b.example", "throttled", "throttled"),
  ]);
  assert.equal(allThrottled.alive, 2, "配额事件不是链路失明,不该报 down");

  const allDead = summarizeRpcQuorum([
    ep("a.example", "unreachable", "unreachable"),
    ep("b.example", "unreachable", "unreachable"),
  ]);
  assert.equal(allDead.alive, 0, "真失明必须报");
});
