/**
 * Executability check for chain-watch alerts (改进 I1).
 *
 * The 15-month backtest's核心事实: 87% of directional notifications had no
 * $100 of real fills within 2h of the signal — the inbox flood was mostly
 * un-tradeable. This module answers, at notify time, "if I opened the app
 * right now, could I actually buy the official direction, at what price,
 * with how much size?" — by mapping the on-chain qid to its Gamma market
 * (conditionId = keccak256(adapter‖qid‖2)) and reading the CLOB book for the
 * directional token.
 *
 * Fail-open by design: chain-watch's job is the timely alert; Gamma/CLOB sit
 * behind the box's proxy and may be down when the chain is fine. Every
 * failure returns null and the alert goes out un-annotated.
 *
 * Neg-risk resolution (2026-07-15, SOOP 九盘考证): for neg-risk events the
 * on-chain qid is the negRiskRequestID — it matches neither Gamma's
 * questionID (= NegRiskOperator marketId+index) nor the regular conditionId
 * formula, so both Gamma routes structurally miss. The real chain is
 * adapter.ctf() → NegRiskOperator (V3.1 → 0x71523d0f…, V4 → 0x661992ae…),
 * operator.questionIds(requestId) → neg-risk questionId, conditionId =
 * keccak256(NegRiskAdapter 0xd91E80cF… ‖ questionId ‖ 2). Detection is
 * adaptive — a regular adapter's ctf() is ConditionalTokens, whose
 * questionIds(qid) call returns empty/zero and we fall through — so no
 * neg-risk adapter allowlist to maintain. Verified on-chain 9/9 against the
 * SOOP batch plus a live V3.1 market (derived cid == Gamma conditionId).
 *
 * Archived/delisted markets (Gamma hides archived rows entirely — the SOOP
 * batch was only visible on CLOB) fall back to CLOB /markets/<conditionId>,
 * mapped into the GammaMarket shape with closed=true unless the book is
 * genuinely tradable.
 *
 * Env: EXEC_CHECK=off disables (annotation absent, alerts unaffected).
 */
import { GAMMA_API, CLOB_API } from "./config";
import { conditionIdFor } from "./keccak";
import { ethCall } from "./oracleState";
// 限价帽:与实盘下单共用的唯一一份实现(零依赖模块,不引入执行层副作用)。
import { limitPriceFor, type LimitBandConfig } from "./priceBands";
import type { GammaMarket, OrderBook } from "../types";

export const MIN_EXEC_USD = 100;
/** Count ask depth only this far above best ask — deeper levels are not "the
 * price you'd pay", they're the slippage cliff. */
const NEAR_ASK_BAND = 0.05;
const FETCH_TIMEOUT_MS = 6_000;

/** fillAvail 走簿的限价天花板 = 实盘该腿的限价,直接调 limitPriceFor
 * (lib/polymarket/priceBands,与 tradeExecutor 下单用的**是同一个函数**),
 * 天花板以上的档位实盘根本吃不到。2026-08-02 审计:本批把 paper 登记门槛从
 * fill100 放宽成 fillAvail 之后,无上界的 walk 会把远端档位算进 avgPrice ——
 * bestAsk 0.66 只有 3 股、下一档 0.95 有 200 股时得出 avgPrice≈0.92 并登记成一笔
 * paper 交易,而实盘限价只有 0.69,这笔"成交"永不存在。
 *
 * 2026-08-02 复查(本轮修的是第一轮修复自身的回归):第一轮把天花板写死成
 * bestAsk + EXEC_SLIPPAGE,对**宣告类**腿系统性偏窄 —— 实盘宣告档走
 * upDriftBand(按剩余边缩放):
 *   ask 0.200 → 天花板 0.230 vs 实盘限价 0.320(窄 0.090)
 *   ask 0.500 → 0.530 vs 0.570(窄 0.040)
 *   ask 0.664 → 0.694 vs 0.710(窄 0.016)
 * 宣告子类(历史兑现 98.8%,本批刚放宽限价帽的正是它)是 EXEC_FORECAST_LIVE
 * 验证期与 8 月 go/no-go 的样本源;少记 shares/usd 并误打 limitCapped 的偏差
 * 方向单一:paper 记的入场价优于实盘真实成交价(自我美化)。
 * 同时纠正第一轮那句"天花板至多宽 1 分钱、不会把实盘能成交的样本挡在外面"
 * 的断言 —— 它是错的:ask=0.666 时旧天花板 0.696,而实盘限价
 * round(0.696×100)/100 = 0.70,天花板反而**更窄**,0.001 tick 的市场上 0.70
 * 那一档被错误排除。改用同一个函数后不存在方向不定的残差。
 *
 * 取舍未变:仍不 import tradeExecutor —— execCheck 是注解层叶子模块
 * (tiering/localDb/heartbeat/chain-watch 共用),tradeExecutor 是带钱包/账本/fs
 * 副作用的执行层,反向 import 既是依赖方向倒置也埋循环隐患。改为双方共同依赖
 * 零依赖的 ./priceBands(它不 import 任何 polymarket 模块,无环)。剩下的唯一
 * 漂移面是下面这三个 env 默认值,须与 execConfig 保持一致。 */

/** 数值 env → 值。显式 0 是合法配置(EXEC_SLIPPAGE=0 且 edgeFrac=0 时天花板
 * 退化为"只吃取整到分档以内的最优档");未设/空串走默认;垃圾值(NaN/负数)
 * loud-warn 后走默认 —— 与 tradeExecutor 的 num() 同口径,静默吞掉会让
 * "操作员设了 0"与"配错了"不可区分。 */
function envNum(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    console.warn(`[exec-check] 环境变量 ${name}="${raw}" 非法,使用默认 ${dflt}`);
    return dflt;
  }
  return v;
}

/** 天花板配置(每次注解现读 env,与实盘同一时刻的 execConfig 取值一致)。
 * 三个键名与默认值逐字抄自 tradeExecutor.execConfig,不得臆造:
 * EXEC_SLIPPAGE 0.03 / EXEC_SLIPPAGE_EDGE_FRAC 0.15 / EXEC_MAX_PRICE 0.995
 * (2026-08-06 从 0.97 抬高;本注释此前漏改,2026-08-07 对齐)。 */
function ceilingConfig(): LimitBandConfig {
  return {
    slippage: envNum("EXEC_SLIPPAGE", 0.03),
    slippageEdgeFrac: envNum("EXEC_SLIPPAGE_EDGE_FRAC", 0.15),
    maxPrice: envNum("EXEC_MAX_PRICE", 0.995),
  };
}

/** 管线帽注入(2026-08-07,0.99 裁决的配套)。调用方管线有自己的入场价上限
 * (chain-watch 的 CHAIN_WATCH_MAX_ASK)时,fillAvail 的天花板必须跟着钉:
 * 否则 (管线帽, EXEC_MAX_PRICE] 区间的腿会按 0.995 天花板走簿并登记进
 * paper 池,而实盘 executeSignal 在同一价位直接 skip —— paper 记着实盘永远
 * 不买的腿,go/no-go 的证据池就是脏的(priceBands 抽取的全部理由正是
 * "paper 与实盘限价逐字同源",分管线帽不能把这个不变量打破)。
 * 语义与 executeSignal 的 maxPriceCap 逐字同源:只收紧不放宽,非法值
 * (NaN/≤0)当没传。导出供 tests/execCheck.test.ts 钉死钳位行为。 */
export function effectiveCeilingConfig(maxPriceCap?: number | null): LimitBandConfig {
  const cfg = ceilingConfig();
  if (maxPriceCap != null && Number.isFinite(maxPriceCap) && maxPriceCap > 0 && maxPriceCap < cfg.maxPrice) {
    cfg.maxPrice = maxPriceCap;
  }
  return cfg;
}

export interface ExecFill {
  price: number;
  size: number;
  cost: number;
}

export interface ExecCheck {
  conditionId: string;
  gammaId: string;
  question: string;
  slug: string | null;
  marketUrl: string | null;
  outcomes: string[];
  /** The outcome side the official direction implies buying. */
  outcome: string;
  tokenId: string;
  dirMethod: "yes-side" | "no-side" | "outcome-exact" | "bucket-contains" | "bucket-anti";
  bestAsk: number | null;
  bestBid: number | null;
  /** book 拉取成功且卖侧为空 —— 与 bestAsk=null 的其余形态(未拉 book/响应
   * 畸形)区分留痕。实测(2026-08-01,飓风家族复盘)CLOB /book 为全镜像:
   * NO ask ≡ 1−YES bid 且 size 一致,故空 asks = 该方向任何价位均无 taker
   * 对手盘,人工手动下单同样无从成交,唯 maker 挂单可吃(策略层,未开)。 */
  bookEmpty: boolean;
  /** Ask-side notional (USD) within NEAR_ASK_BAND of best ask. */
  askUsdNear: number;
  /** askUsdNear ≥ MIN_EXEC_USD — the backtest's "真可执行" bar. */
  executable: boolean;
  /** Simulated $100 market buy walking the asks (null when book too thin). */
  fill100: { avgPrice: number; worstPrice: number; shares: number; usd: number; fills: ExecFill[] } | null;
  /** 尽力口径:在限价天花板内走完可得的 asks,不要求吃满 MIN_EXEC_USD。
   * 2026-08-02 复盘:paper 池上线至今 0 行,根因是登记门槛挂在 fill100 上,
   * 而实测最厚一腿深度只有 ~$52 —— 连唯一那笔 +48% 的真实成交都不够格登记,
   * 预告家族"paper 验证期"因此永远无法结束(死锁)。
   * 回测的"真可执行"口径仍看 executable/fill100,不受本字段影响。
   *
   * 2026-08-02 审计(finding 4):walk 加了限价天花板 ceiling,只吃实盘限价买得到
   * 的档位;08-02 复查起天花板 = limitPriceFor(bestAsk, declarative, cfg),即实盘
   * 该腿的限价本身(宣告档按剩余边缩放,不再被普通档的绝对滑点带压窄)。
   * 常规价位下天花板 ≥ bestAsk,最优档永远在内,登记死锁不会因此复发;例外只有
   * 两种,且都是实盘同样吃不到的形态,fillAvail=null 是正确镜像:
   *  · bestAsk > EXEC_MAX_PRICE(默认 0.995,2026-08-06 从 0.97 抬高)—— 实盘走
   *    "ask > 上限(尾价/已重定价)"直接 skip;
   *  · 显式把 EXEC_SLIPPAGE 与 EXEC_SLIPPAGE_EDGE_FRAC 都配成 0 —— 带宽归零后
   *    round(ask×100)/100 可能落在 ask 之下(0.664→0.66),实盘同样因"限价内深度
   *    为 0"skip。
   * 加了天花板之后 fillAvail 与 fill100 走的是两次独立 walk,厚簿但价差大的盘会
   * 出现"fill100 非空、fillAvail 却 capped"的组合 —— 这不是矛盾,正是两个口径的
   * 差别所在。
   *
   * 两个 capped 语义不同,go/no-go 分桶必须分开看:
   *  · capped=false            → 天花板内吃满 $100,价格实盘拿得到。**唯一可
   *    直接进主口径均值的桶。**
   *  · capped ∧ !limitCapped   → 纯深度不足(限价内的档位全吃光也不到 $100)。
   *    价格可信、规模不可信;单列"薄簿桶",名义收益率不与足额样本混算均值。
   *  · limitCapped=true        → walk 被天花板截断(蕴含 capped:只有没吃满
   *    才可能是被截断)。usd/shares 是实盘该价位上真能拿到的量,更深的便宜货
   *    并不存在;单列"限价截断桶",它反映的是薄簿+价差,不是策略容量。 */
  fillAvail: {
    avgPrice: number;
    worstPrice: number;
    shares: number;
    usd: number;
    fills: ExecFill[];
    /** 没吃满 MIN_EXEC_USD(原义不变,深度不足或被天花板截断都会置真)。 */
    capped: boolean;
    /** walk 被限价天花板截断(簿子里还有更贵的档位没吃)——与"簿子见底"的
     * 深度不足区分,两者在事后分层里意义不同。 */
    limitCapped: boolean;
    /** 本次 walk 实际使用的价格上界 = limitPriceFor(bestAsk, declarative, cfg)
     * = 实盘该腿此刻会挂的限价。落库留痕,便于事后按当时的带宽与子类口径复算
     * (env 或 declarative 判定改过就不能用当前值反推)。 */
    ceiling: number;
  } | null;
  endDate: string | null;
  /** Gamma 事件 ID(同一事件下的兄弟腿共享)。用于执行侧的同事件聚合敞口帽:
   * 一条澄清同时触发 N 个独立市场时,单笔/单日闸门约束不住"同一个判断压了
   * N×maxOrder"(2026-07-28 飓风家族三腿共享 event 744619)。 */
  eventId: string | null;
  closed: boolean;
  negRisk: boolean;
  feesEnabled: boolean | null;
  feeRate: number | null;
}

/** 模拟市价买单沿 asks(须已按价升序)逐档吃单。usdBudget 用尽、簿子见底、
 * 或档位价超过 ceiling 三者任一即停。ceiling=Infinity 表示不设限价 ——
 * fill100 走这一路,取值与语义一律不动(它是回测"真可执行"口径的锚)。 */
function walkAsks(
  asks: Array<{ price: number; size: number }>,
  usdBudget: number,
  ceiling: number
): { shares: number; cost: number; fills: ExecFill[] } {
  let usdLeft = usdBudget;
  let shares = 0;
  let cost = 0;
  const fills: ExecFill[] = [];
  for (const l of asks) {
    if (usdLeft <= 0.01) break;
    if (l.price > ceiling) break;
    const take = Math.min(l.size, usdLeft / l.price);
    fills.push({ price: l.price, size: take, cost: take * l.price });
    shares += take;
    cost += take * l.price;
    usdLeft -= take * l.price;
  }
  return { shares, cost, fills };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 方向 stance 的整串匹配(仅容 leans_ 前缀)。P0-2:原 /YES$/i、/NO$/i 是
 * 子串后缀匹配,resolve_to_bruno、resolve_to_hayes 之类以 -no/-yes 结尾的
 * 标签会被劫持到 yes/no 分支,永远到不了 outcome-exact。 */
const YES_STANCE = /^(?:leans_)?yes$/i;
const NO_STANCE = /^(?:leans_)?no$/i;

/** 极性归一(标题分诊与复判一致性共用):YES/leans_YES → "+",NO/leans_NO
 * → "-",其余(含 resolve_to_*)原样返回、要求字面一致 —— 刻意不做
 * resolve_to 归一化比较:放宽它会扩大 🟢 覆盖面,必须等方向映射正确性在
 * 生产验证后再单独评估(P0-2 顺序警告)。 */
export function stancePolarity(stance: string): string {
  if (YES_STANCE.test(stance)) return "+";
  if (NO_STANCE.test(stance)) return "-";
  return stance;
}

/** Map a directional stance to the outcome side it implies buying. Same
 * decision table the backtest's economics used (dirMethod hard-error rate
 * concentrated in bucket heuristics — those stay lowest-trust downstream:
 * 自动执行白名单只放行 yes-side/no-side/outcome-exact,见 chain-watch)。 */
export function directionalOutcomeIndex(
  stance: string,
  outcomes: string[],
  question: string | null
): { index: number; method: ExecCheck["dirMethod"] } | null {
  const lower = outcomes.map((o) => o.toLowerCase().trim());
  // resolve_to_ 前缀必须最先判:它的标签是自由词,先走后缀正则就会被劫持(P0-2)。
  if (stance.startsWith("resolve_to_")) {
    const label = stance.slice("resolve_to_".length).toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const exact = lower.indexOf(label);
    if (exact >= 0) return { index: exact, method: "outcome-exact" };
    const isYesNo = outcomes.length === 2 && [...lower].sort().join() === "no,yes";
    if (isYesNo) {
      const q = (question ?? "").toLowerCase();
      if (q.includes(label)) return { index: lower.indexOf("yes"), method: "bucket-contains" };
      return { index: lower.indexOf("no"), method: "bucket-anti" };
    }
    return null;
  }
  // YES/NO 只在市场确实存在同名 outcome 时映射;找不到就返回 null——
  // fallback 到固定下标 0/1 等于在非 yes/no 市场随机买一边,确定性 -100%。
  if (YES_STANCE.test(stance)) {
    const i = lower.indexOf("yes");
    return i >= 0 ? { index: i, method: "yes-side" } : null;
  }
  if (NO_STANCE.test(stance)) {
    const i = lower.indexOf("no");
    return i >= 0 ? { index: i, method: "no-side" } : null;
  }
  return null;
}

/** NegRiskAdapter(经典部署,V3.1/V4 两家 operator 的 nrAdapter() 均指向它,
 * 2026-07-15 链上实测)——neg-risk CTF condition 的 oracle。 */
export const NEG_RISK_ADAPTER = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
/** ctf() —— UMA adapter 的 CTF 指针;neg-risk 部署上它指向 NegRiskOperator。 */
export const CTF_SELECTOR = "0x22a9339f";
/** questionIds(bytes32) —— NegRiskOperator 的 requestId→questionId 映射。 */
export const QUESTION_IDS_SELECTOR = "0xdc89a198";

export function deriveNegRiskConditionId(negRiskQuestionId: string): string {
  return conditionIdFor(NEG_RISK_ADAPTER, negRiskQuestionId);
}

/** adapter → ctf() 地址。只缓存成功结果:RPC 瞬断不能被永久记成"非 neg-risk"。 */
const ctfAddressCache = new Map<string, string>();

/** neg-risk 家族的 qid(= negRiskRequestID)→ 真 conditionId。自适应探测:
 * 常规 adapter 的 ctf() 是 ConditionalTokens,questionIds 调用返回空/零 →
 * null(非 neg-risk)。任何 RPC 失败也返回 null(fail-open,下轮再试)。 */
async function negRiskConditionId(adapter: string, qid: string): Promise<string | null> {
  try {
    const key = adapter.toLowerCase();
    let ctfAddr = ctfAddressCache.get(key) ?? null;
    if (!ctfAddr) {
      const raw = (await ethCall(adapter, CTF_SELECTOR)).toLowerCase();
      if (!/^0x0{24}[0-9a-f]{40}$/.test(raw)) return null;
      ctfAddr = `0x${raw.slice(-40)}`;
      ctfAddressCache.set(key, ctfAddr);
    }
    const nrQid = (await ethCall(ctfAddr, QUESTION_IDS_SELECTOR + qid.slice(2).toLowerCase())).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(nrQid) || /^0x0{64}$/.test(nrQid)) return null;
    return deriveNegRiskConditionId(nrQid);
  } catch {
    return null;
  }
}

/** CLOB /markets/<cid> 响应 → GammaMarket 形状(纯转换,供测试)。归档/下架
 * 市场 Gamma 完全不列(SOOP 批只在 CLOB 可见),这是它们唯一的可见面。
 * `closed` 语义收紧为"不可交易":closed/archived/book 关闭任一命中即 true,
 * 下游 maybeExecuteTrade 的 e.closed 分支与 paper 登记闸门都依赖它兜底。 */
export function clobToGammaMarket(m: {
  condition_id?: string;
  question?: string;
  market_slug?: string;
  end_date_iso?: string | null;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enable_order_book?: boolean;
  neg_risk?: boolean;
  tokens?: Array<{ token_id?: string; outcome?: string }>;
}): GammaMarket | null {
  const tokens = Array.isArray(m.tokens) ? m.tokens : [];
  if (!m.condition_id || tokens.length === 0 || !tokens.every((t) => t.token_id && t.outcome)) {
    return null;
  }
  const tradable = m.enable_order_book === true && m.archived !== true && m.closed !== true;
  return {
    id: "",
    question: m.question ?? "",
    conditionId: m.condition_id,
    slug: m.market_slug ?? "",
    endDate: m.end_date_iso ?? null,
    active: m.active === true,
    closed: !tradable,
    enableOrderBook: m.enable_order_book,
    archived: m.archived,
    outcomes: JSON.stringify(tokens.map((t) => String(t.outcome))),
    clobTokenIds: JSON.stringify(tokens.map((t) => String(t.token_id))),
    negRisk: m.neg_risk === true,
    // CLOB /markets 不含这三个 Gamma 字段;execCheck 不读它们,置空即可。
    outcomePrices: "[]",
    volume: "0",
    liquidity: "0",
  };
}

async function clobLookup(cid: string): Promise<GammaMarket | null> {
  try {
    const m = await fetchJson<Parameters<typeof clobToGammaMarket>[0]>(`${CLOB_API}/markets/${cid}`);
    if (m?.condition_id?.toLowerCase() !== cid.toLowerCase()) return null;
    return clobToGammaMarket(m);
  } catch {
    return null;
  }
}

async function lookupMarket(adapter: string, qid: string): Promise<GammaMarket | null> {
  const cid = conditionIdFor(adapter, qid);
  // Gamma 默认不返回已关闭行(存量洞:condition_ids 须带 closed=true 才命中
  // 已结算市场),每路都查两种口径。网络层一旦抛错(≠查空)说明 Gamma 整体
  // 不可达,跳过其余 Gamma 路由直奔兜底 —— 避免注解循环在断网 tick 上把
  // 每个 6s 超时都吃满。
  let gammaDown = false;
  const gammaFind = async (
    params: string,
    match: (m: GammaMarket) => boolean
  ): Promise<GammaMarket | null> => {
    if (gammaDown) return null;
    try {
      const rows = await fetchJson<GammaMarket[] | null>(`${GAMMA_API}/markets?${params}`);
      return (Array.isArray(rows) ? rows : []).find(match) ?? null;
    } catch {
      gammaDown = true;
      return null;
    }
  };
  const byCid = (m: GammaMarket) => m.conditionId?.toLowerCase() === cid.toLowerCase();
  const byQid = (m: GammaMarket) => m.questionID?.toLowerCase() === qid.toLowerCase();
  const regular =
    (await gammaFind(`condition_ids=${cid}&limit=2`, byCid)) ??
    (await gammaFind(`condition_ids=${cid}&closed=true&limit=2`, byCid)) ??
    (await gammaFind(`question_ids=${qid}&limit=2`, byQid)) ??
    (await gammaFind(`question_ids=${qid}&closed=true&limit=2`, byQid));
  if (regular) return regular;

  // neg-risk 家族:qid 是 negRiskRequestID,常规两路必然落空 → operator 映射
  // 推导真 conditionId。推导成功即权威(operator 认得这个 requestId),不再
  // 回落常规 cid 的 CLOB 查询。
  const nrCid = await negRiskConditionId(adapter, qid);
  if (nrCid) {
    const byNrCid = (m: GammaMarket) => m.conditionId?.toLowerCase() === nrCid.toLowerCase();
    const viaGamma =
      (await gammaFind(`condition_ids=${nrCid}&limit=2`, byNrCid)) ??
      (await gammaFind(`condition_ids=${nrCid}&closed=true&limit=2`, byNrCid));
    return viaGamma ?? (await clobLookup(nrCid));
  }
  // 常规市场的归档兜底:Gamma 不列 archived 行,CLOB 是唯一可见面。
  return clobLookup(cid);
}

/**
 * Look up the market for an on-chain (adapter, qid) and measure how much of
 * the official direction is actually buyable right now. Returns null on any
 * failure or when the direction cannot be mapped to an outcome side.
 */
export async function checkExecutability(input: {
  adapter: string;
  qid: string;
  /** Effective directional stance (regex stance when directional, else the
   * LLM stance) — decides which outcome side to price. */
  stance: string;
  /** 宣告类裁定(官方文本直接写明结算结果)。只影响 fillAvail 的限价天花板:
   * 实盘对这个子类按剩余边缩放放宽限价(tradeExecutor 的 declarative 扫单),
   * 天花板必须跟着放宽,否则 paper 行系统性少记 shares/usd 并误打 limitCapped
   * (2026-08-02 复查)。默认 false = 普通档绝对滑点带,向后兼容:未传的调用方
   * 拿到的天花板与第一轮修复逐字一致。 */
  declarative?: boolean;
  /** 调用方管线的价格帽(chain-watch 透传 CHAIN_WATCH_MAX_ASK)。只收紧
   * fillAvail 的天花板、不放宽;未传 = 只按 EXEC_MAX_PRICE(与 2026-08-07
   * 之前行为逐字一致)。见 effectiveCeilingConfig。 */
  maxPriceCap?: number | null;
}): Promise<ExecCheck | null> {
  if ((process.env.EXEC_CHECK ?? "").trim().toLowerCase() === "off") return null;
  try {
    const market = await lookupMarket(input.adapter, input.qid);
    if (!market) return null;

    const outcomes = parseJsonArray(market.outcomes);
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (outcomes.length === 0 || tokenIds.length !== outcomes.length) return null;

    const dir = directionalOutcomeIndex(input.stance, outcomes, market.question);
    if (!dir || dir.index < 0 || dir.index >= tokenIds.length) return null;
    const tokenId = tokenIds[dir.index];

    let bestAsk: number | null = null;
    let bestBid: number | null = null;
    let bookEmpty = false;
    let askUsdNear = 0;
    let fill100: ExecCheck["fill100"] = null;
    let fillAvail: ExecCheck["fillAvail"] = null;

    if (!market.closed && market.enableOrderBook !== false) {
      const book = await fetchJson<OrderBook>(`${CLOB_API}/book?token_id=${tokenId}`);
      const asks = (book.asks ?? [])
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
        .sort((a, b) => a.price - b.price);
      const bids = (book.bids ?? [])
        .map((l) => Number(l.price))
        .filter((p) => Number.isFinite(p))
        .sort((a, b) => b - a);
      bestBid = bids[0] ?? null;
      // 空盘判定:响应结构完好(带 asks 数组或 market 标识)才算真空盘;
      // 200 但畸形的瞬态坏响应(两者皆缺)不冒充空盘,维持 bookEmpty=false,
      // 下游按"注解异常"口径处理。
      if (asks.length === 0 && (Array.isArray(book.asks) || book.market != null)) {
        bookEmpty = true;
      }
      if (asks.length > 0) {
        bestAsk = asks[0].price;
        const ceiling = Math.min(bestAsk + NEAR_ASK_BAND, 0.999);
        for (const l of asks) {
          if (l.price > ceiling) break;
          askUsdNear += l.price * l.size;
        }
        // Walk the asks for a simulated $100 market buy(不设限价 —— 回测锚
        // 口径,取值与语义与本批之前完全一致)。
        const { shares, cost, fills } = walkAsks(asks, MIN_EXEC_USD, Infinity);
        if (cost >= MIN_EXEC_USD - 0.01 && shares > 0) {
          fill100 = {
            avgPrice: cost / shares,
            worstPrice: fills[fills.length - 1].price,
            shares,
            usd: cost,
            fills,
          };
        }
        // 尽力口径(2026-08-02 审计 finding 4):独立走一次带限价天花板的
        // walk。此前它复用上面那次无上界的 walk,薄簿场景会把远高于实盘限价帽
        // 的档位算进 avgPrice(0.66 三股 + 0.95 两百股 → 0.92,而实盘限价只有
        // 0.69),登记进 paper 池 = 系统性低估策略收益率。
        // 08-02 复查:天花板改成直接调实盘那支 limitPriceFor —— 第一轮自己写的
        // bestAsk+EXEC_SLIPPAGE 对宣告档窄了最多 0.09(ask 0.20 处 0.23 vs 0.32),
        // 偏差方向是把 paper 池美化成"入场价优于实盘"。
        const fillCeiling = limitPriceFor(bestAsk, input.declarative === true, effectiveCeilingConfig(input.maxPriceCap));
        const avail = walkAsks(asks, MIN_EXEC_USD, fillCeiling);
        if (avail.shares > 0) {
          const availCapped = avail.cost < MIN_EXEC_USD - 0.01;
          fillAvail = {
            avgPrice: avail.cost / avail.shares,
            worstPrice: avail.fills[avail.fills.length - 1].price,
            shares: avail.shares,
            usd: avail.cost,
            fills: avail.fills,
            capped: availCapped,
            // 被天花板截断 ⇔ 没吃满 $100 且簿子里还有更贵的档位没吃(asks 已
            // 升序,故末档超天花板即等价于"存在被截断的档位")。深度不足与
            // 限价截断在事后分层里意义不同,见 ExecCheck.fillAvail 的分桶说明。
            limitCapped: availCapped && asks[asks.length - 1].price > fillCeiling,
            ceiling: fillCeiling,
          };
        }
      }
    }

    const rate = market.feeSchedule?.rate;
    return {
      conditionId: market.conditionId,
      gammaId: market.id,
      question: market.question,
      slug: market.slug || null,
      marketUrl: market.slug ? `https://polymarket.com/market/${market.slug}` : null,
      outcomes,
      outcome: outcomes[dir.index],
      tokenId,
      dirMethod: dir.method,
      bestAsk,
      bestBid,
      bookEmpty,
      askUsdNear: Math.round(askUsdNear * 100) / 100,
      executable: askUsdNear >= MIN_EXEC_USD,
      fill100,
      fillAvail,
      endDate: market.endDate ?? null,
      eventId: market.events?.[0]?.id ?? null,
      closed: market.closed === true,
      negRisk: market.negRisk === true,
      feesEnabled: market.feesEnabled ?? null,
      feeRate: typeof rate === "number" ? rate : null,
    };
  } catch {
    return null; // fail-open: annotation is enrichment, never a gate on the alert itself
  }
}
