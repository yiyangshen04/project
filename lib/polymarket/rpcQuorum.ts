/** RPC 法定人数探针的**判据**部分,与网络 I/O 分离。
 *
 * 抽出来的唯一理由是断言接缝:判据埋在 `probeRpcQuorum` 里就只能靠真网络测,
 * 而"配额拒绝被算成端点已死"这类错误恰恰只在特定应答形态下出现,真网络里
 * 可遇不可求(2026-08-07 复现它花了十几轮突发探测)。见 [[prededge-audit-fix-2026-08-03]]
 * 的教训:判据没有断言接缝,整类缺陷就只能靠运气发现。
 */

/** 单条路(代理 / 直连)的三态。
 *
 * **429/配额拒绝不是链路故障** —— 对端回了 HTTP 应答这件事本身就证明链路通,
 * 把它算成"死"正是让配额事件长得跟宕机一模一样的根因。2026-08-07 晚实测:
 * 代理与直连在**同一瞬间同时** 403,而两条路走的是两个完全不同的出口 IP,
 * 不可能同时撞上按 IP 的限流 ⟹ 那是对端的闸,不是我们的网。 */
export type RpcRouteState = "ok" | "throttled" | "unreachable";

/** 限流/配额的指纹。命中即判 throttled,否则按不可达处理。
 * **刻意从严**:`403 API key disabled, reason: tenant disabled` 这类**真**失效
 * (polygon-rpc.com 现况)绝不能被涂成"只是限流"。 */
const THROTTLE_RE = /rate.?limit|too.?many|quota|exceed|throttl|capacity|credits?\b/i;

/** 把一次 HTTP 应答判成三态。`body` 允许为空字符串(读不到正文)。 */
export function classifyRpcRouteState(status: number, body: string): RpcRouteState {
  if (status === 429) return "throttled";
  if (status < 200 || status >= 300) {
    return THROTTLE_RE.test(body) ? "throttled" : "unreachable";
  }
  let parsed: { result?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // 2xx 却不是 JSON:限流页/挡板页常是这个形态,靠正文关键词兜一层。
    return THROTTLE_RE.test(body) ? "throttled" : "unreachable";
  }
  if (parsed?.error == null && typeof parsed?.result === "string") return "ok";
  // 200 包着 JSON-RPC error —— 1rpc 配额耗尽就是这个形态,与端点故障必须分开。
  return THROTTLE_RE.test(parsed?.error?.message ?? body) ? "throttled" : "unreachable";
}

export interface RpcEndpointStates {
  host: string;
  proxy: RpcRouteState;
  direct: RpcRouteState;
}

export interface RpcQuorum {
  /** 至少有一条路**链路可达**的端点数(含被限流的)。告警判据用这个。 */
  alive: number;
  total: number;
  /** 两条路都不可达 —— 真正的"死"。 */
  dead: string[];
  /** 链路可达、但每条应答的路都在限流,一次都没取到可用读数。 */
  throttled: string[];
  /** 分路**可达**数 —— 区分"Clash 死了"和"国际出口烂了"。 */
  viaProxy: number;
  viaDirect: number;
  /** 分路**取到可用读数**数。与可达数的差额就是限流的量。 */
  usableProxy: number;
  usableDirect: number;
}

const reachable = (s: RpcRouteState): boolean => s !== "unreachable";

/** 逐端点三态 → 法定人数读数。纯函数,无 I/O。 */
export function summarizeRpcQuorum(results: readonly RpcEndpointStates[]): RpcQuorum {
  const anyReachable = (r: RpcEndpointStates) => reachable(r.proxy) || reachable(r.direct);
  const anyUsable = (r: RpcEndpointStates) => r.proxy === "ok" || r.direct === "ok";
  return {
    alive: results.filter(anyReachable).length,
    total: results.length,
    dead: results.filter((r) => !anyReachable(r)).map((r) => r.host),
    throttled: results.filter((r) => anyReachable(r) && !anyUsable(r)).map((r) => r.host),
    viaProxy: results.filter((r) => reachable(r.proxy)).length,
    viaDirect: results.filter((r) => reachable(r.direct)).length,
    usableProxy: results.filter((r) => r.proxy === "ok").length,
    usableDirect: results.filter((r) => r.direct === "ok").length,
  };
}
