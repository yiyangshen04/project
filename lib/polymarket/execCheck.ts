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
import type { GammaMarket, OrderBook } from "../types";

export const MIN_EXEC_USD = 100;
/** Count ask depth only this far above best ask — deeper levels are not "the
 * price you'd pay", they're the slippage cliff. */
const NEAR_ASK_BAND = 0.05;
const FETCH_TIMEOUT_MS = 6_000;

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
  /** 尽力口径:走完限价内可得的 asks,不要求吃满 MIN_EXEC_USD(capped=true
   * 表示深度不足 $100)。2026-08-02 复盘:paper 池上线至今 0 行,根因是登记
   * 门槛挂在 fill100 上,而实测最厚一腿深度只有 ~$52 —— 连唯一那笔 +48% 的
   * 真实成交都不够格登记,预告家族"paper 验证期"因此永远无法结束(死锁)。
   * 回测的"真可执行"口径仍看 executable/fill100,不受本字段影响。 */
  fillAvail: {
    avgPrice: number;
    worstPrice: number;
    shares: number;
    usd: number;
    fills: ExecFill[];
    capped: boolean;
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
        // Walk the asks for a simulated $100 market buy.
        let usdLeft = MIN_EXEC_USD;
        let shares = 0;
        let cost = 0;
        const fills: ExecFill[] = [];
        for (const l of asks) {
          if (usdLeft <= 0.01) break;
          const take = Math.min(l.size, usdLeft / l.price);
          fills.push({ price: l.price, size: take, cost: take * l.price });
          shares += take;
          cost += take * l.price;
          usdLeft -= take * l.price;
        }
        // 尽力口径:同一次 walk 的结果,只是不要求走满 $100。深度不足时
        // capped=true,登记侧据此分桶(薄簿样本不与足额样本混算均值)。
        if (shares > 0) {
          fillAvail = {
            avgPrice: cost / shares,
            worstPrice: fills[fills.length - 1].price,
            shares,
            usd: cost,
            fills,
            capped: cost < MIN_EXEC_USD - 0.01,
          };
        }
        if (cost >= MIN_EXEC_USD - 0.01 && shares > 0) {
          fill100 = {
            avgPrice: cost / shares,
            worstPrice: fills[fills.length - 1].price,
            shares,
            usd: cost,
            fills,
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
