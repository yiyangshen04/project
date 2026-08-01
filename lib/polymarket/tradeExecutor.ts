/**
 * Automated order execution for chain-watch 🟢 signals (2026-07-10).
 *
 * Gate semantics live in chain-watch (identical to paper-trade registration:
 * 🟢 label = regex∧LLM double-confirm at conf=high, post M1/M2/M3 downgrades);
 * this module owns everything after the gate: risk caps, freshness re-check,
 * marketable-limit FAK order via CLOB V2, and the append-only trade ledger.
 *
 * Fail-open by design like execCheck: ANY failure here returns a TradeAttempt
 * (never throws), and the alert email always goes out — execution is an
 * enrichment of the alert path, never a gate on it.
 *
 * Access triple (verified read-only 2026-07-10, 8/8 + on-chain EIP-1271
 * pre-play): signer = EOA in ~/.prededge/trading-wallet.json, funder = proxy
 * 0x3a6075…6Db9, signatureType = 3 (POLY_1271; the order's signer field
 * equals the maker/proxy by design — EOA sig is ERC-7739-wrapped inside).
 *
 * Env:
 *   EXEC_MODE            off (default) | dry (全链路含签名,不 postOrder) | live
 *   EXEC_WALLET_JSON     default ~/.prededge/trading-wallet.json
 *   EXEC_CREDS_JSON      default ~/.prededge/clob-creds.json (L2 creds cache)
 *   EXEC_FUNDER          default 0x3a60750796A52e84DA325B74C5ad5c031f296Db9
 *   EXEC_MAX_ORDER_USD   default 50   (单笔上限)
 *   EXEC_DAILY_MAX_USD   default 150  (UTC 日累计上限,按实际成交 filledUsd 计;
 *                        posted=unknown 保守按 requested。P0-1 修复前按 requested
 *                        计且零成交/拒单也占额,8 次尝试即打满)
 *   EXEC_TOTAL_MAX_USD   default 400  (当前未结算持仓上限;已结算市场经 Gamma
 *                        核销释放,缓存于 ledger 同目录 trade-settled.json)
 *   EXEC_MIN_ORDER_USD   default 5    (低于此值不值得付固定成本)
 *   EXEC_MAX_PRICE       default 0.97 (入场价上限;≥0.97 是尾价 carry,自动模式不吃)
 *   EXEC_MIN_PRICE       default 0.15 (入场价下限;bt4 定量:0.03-0.15 彩票区
 *                        历史 4/4 归零、真肥尾入场价均 ≥0.15。这同时是 M2 极端
 *                        逆共识红旗(注解时刻 ask<0.15)在执行侧的地板 —— 原默认
 *                        0.12 与自家研究结论打架,留出 0.12-0.15 的时间差绕行区)
 *   EXEC_SLIPPAGE        default 0.03 (限价帽 = 新鲜 ask + slippage;也是漂移带的下限)
 *   EXEC_SLIPPAGE_EDGE_FRAC  default 0.15 (上行漂移带按剩余边缩放:容忍
 *                        max(EXEC_SLIPPAGE, frac×(1−signalAsk));绝对带在 0.16
 *                        价位是 18% 相对档,肥尾回归途中 0.164→0.20 被拒而
 *                        0.20 买入仍 +400% —— 实盘低于回测的第一大来源,§2.3)
 *   EXEC_CRASH_DROP_FRAC default 0.35 (下行守卫:freshAsk 较信号价跌超
 *                        max(EXEC_SLIPPAGE, frac×signalAsk) = 市场把裁定读成
 *                        反方向,skip 待人工复核,不当便宜货买)
 *   EXEC_LOSS_HALT_COUNT default 3    (结算对账连亏 N 笔 → 自动落 halt 文件)
 *   EXEC_SKIP_FORECAST_TEMPLATE  default off(2026-07-14 官方行为研究 §7.2 策略反转:
 *                        预告模板家族从一刀切 skip 改三闸门制 —— bt5/E3b 的"绿档均值
 *                        −5.5%"结论只对预告期入场成立,肉在落地瞬间(簇级 meat 中位
 *                        9~17pp);历史重放 15 个月:三闸门 16 笔全胜 +$194,无闸裸执行
 *                        −$195。on = 恢复旧一刀切 skip)
 *   EXEC_FORECAST_MIN_PRICE  default 0.30(预告家族防雷闸:方向侧信号价 <0.30 =
 *                        市场不跟随澄清方向,文本可疑/姊妹盘错配形态,不执行)
 *   EXEC_FORECAST_LIVE   default off(预告家族 paper 验证期:三闸门通过后 live 模式
 *                        也不实弹,先观察 4-6 周线上判读口径下的闸门表现;验证通过
 *                        后置 on 放实弹。期望量级 $5-15/月,与主策略共用管线)
 *   EXEC_HALT_FILE       default data/trading-halt(存在即停;连续 3 次 live error 自动创建)
 *   EXEC_LEDGER          default data/trade-ledger.jsonl
 *
 * Ledger 语义(2026-07-11 审计修复批):live 单在 postOrder 前先落 status="intent"
 * 的 write-ahead 行(posted="unknown" 按 requestedUsd 占额并封锁该 token 去重),
 * 终态行经同一 attemptId 在读取时取代它 —— 进程死在下单在途窗口时孤儿 intent
 * 保守视作持仓。postOrder 的超时、传输层异常、无 HTTP status 的错误对象、
 * delayed/live 未终局状态一律 posted="unknown";只有带 status 的真拒单与明确
 * 零成交(unmatched)记 $0。
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import path from "path";
import { homedir } from "os";
import { CLOB_API, GAMMA_API } from "./config";
import { ethCall } from "./oracleState";
import { writeFileAtomic } from "../fsAtomic";

export type ExecMode = "off" | "dry" | "live";

export interface TradeAttempt {
  mode: ExecMode;
  /** filled/partial: 实际成交;none: FAK 未匹配即撤;dry: 已构造未提交;
   * skipped: 风控/条件不满足;error: 执行异常。 */
  status: "filled" | "partial" | "none" | "dry" | "skipped" | "error";
  reason?: string;
  orderId?: string;
  requestedUsd?: number;
  limitPrice?: number;
  /** 下单前重读盘口拿到的最优卖价(信号注解可能已过时数十秒)。 */
  freshAsk?: number | null;
  filledUsd?: number;
  filledShares?: number;
  avgPrice?: number;
  /** 实收 taker 费(Fee Structure V2;成交时按 filledUsd×rate×(1−均价) 计,
   * 费率未知按平费 0.002 保守兜底)。结算盈亏的 cost 含此项。 */
  feeUsd?: number;
  /** postOrder 是否已发出(true/false/"unknown" 超时未知)——资金占用按此计。 */
  posted?: boolean | "unknown";
  latencyMs?: number;
  /** 需要提到邮件主题级的风控状态(如额度打满,P0-1④)。 */
  subjectAlert?: string;
}

export interface TradeSignalInput {
  qid: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  question: string;
  marketUrl: string | null;
  /** priorityOf 的完整标签,进 ledger 供事后按档位归因。 */
  label: string;
  stance: string;
  llmStance?: string | null;
  llmConfidence?: string | null;
  /** LLM 判读的事件状态(decided/pending/unclear)——预告家族 boundary 闸
   * 的输入:leans ∧ pending = 快照雷形态(历史重放全部 -100% 在此)。 */
  llmEventStatus?: string | null;
  /** 信号注解时刻的 bestAsk(漂移防护的基准;null = 注解时无盘口)。 */
  bestAskAtSignal: number | null;
  /** 注解时 book 实测空盘(execCheck.bookEmpty)。bestAskAtSignal=null 时用于
   * 区分"空盘 taker 不可成交"(2026-08-01 复盘:CLOB book 全镜像,空 asks =
   * 任何价位无对手盘,人工也无从下单)与"注解异常须人工核对"两种 skip 口径。 */
  bookEmpty?: boolean;
  /** execCheck 的方向映射方法,进 ledger 供事后归因(P0-2⑤)。自动执行的
   * bucket-* 白名单拦截在 chain-watch 的 maybeExecuteTrade。 */
  dirMethod?: string;
  negRisk?: boolean;
  /** 市场费注解(execCheck feeSchedule 透传,taker 费记账用;2026-07-19 审查
   * §2:此前 execCheck 明明取到了却在组装时丢弃,实盘盈亏全程不含费,
   * won/连亏链系统性偏乐观)。undefined/null = 未知,按平费兜底。 */
  feesEnabled?: boolean | null;
  feeRate?: number | null;
  forecastTemplate?: boolean;
  correction?: boolean;
  /** 本 tick 剩余墙钟预算;不足则跳过,绝不拖垮告警路径。 */
  budgetMs: number;
  /** selftest/probe 专用:ledger 记录带 probe 标记,不参与去重与额度累计。 */
  probe?: boolean;
}

interface LedgerEntry extends Omit<TradeAttempt, "status"> {
  /** "intent" 只存在于 ledger:postOrder 发出前的 write-ahead 行(posted=
   * "unknown" 占额+封锁去重),终态行落地后经 attemptId 取代;进程在两行之间
   * 死亡时孤儿 intent 把"可能已成交"保守当持仓,直到结算核销。 */
  status: TradeAttempt["status"] | "intent";
  at: string;
  qid: string;
  tokenId: string;
  /** 同一次执行尝试的 intent 行与终态行共享此 id,readLedger 只保留最后一行。 */
  attemptId?: string;
  conditionId?: string;
  outcome?: string;
  question?: string;
  label?: string;
  stance?: string;
  llmStance?: string | null;
  llmConfidence?: string | null;
  signalAsk?: number | null;
  dirMethod?: string | null;
  probe?: boolean;
  raw?: unknown;
}

/** 数值环境变量。显式 0 是合法配置(如 EXEC_SLIPPAGE=0);未设/空串走默认;
 * 垃圾值(NaN/负数)loud-warn 后走默认 —— 原实现把 0 与垃圾一样静默吞成默认,
 * 操作员"设了 0"与"没设"不可区分(2026-07-19 审查顺手项)。 */
const num = (name: string, dflt: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    console.warn(`[trade-executor] 环境变量 ${name}="${raw}" 非法,使用默认 ${dflt}`);
    return dflt;
  }
  return v;
};
const expandHome = (p: string): string => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);
const rel = (p: string): string => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));

export function executionMode(): ExecMode {
  const m = (process.env.EXEC_MODE ?? "off").trim().toLowerCase();
  return m === "live" || m === "dry" ? m : "off";
}

export function execConfig() {
  return {
    mode: executionMode(),
    walletJson: expandHome(process.env.EXEC_WALLET_JSON?.trim() || "~/.prededge/trading-wallet.json"),
    credsJson: expandHome(process.env.EXEC_CREDS_JSON?.trim() || "~/.prededge/clob-creds.json"),
    funder: process.env.EXEC_FUNDER?.trim() || "0x3a60750796A52e84DA325B74C5ad5c031f296Db9",
    maxOrderUsd: num("EXEC_MAX_ORDER_USD", 50),
    dailyMaxUsd: num("EXEC_DAILY_MAX_USD", 150),
    totalMaxUsd: num("EXEC_TOTAL_MAX_USD", 400),
    minOrderUsd: num("EXEC_MIN_ORDER_USD", 5),
    maxPrice: num("EXEC_MAX_PRICE", 0.97),
    minPrice: num("EXEC_MIN_PRICE", 0.15),
    slippage: num("EXEC_SLIPPAGE", 0.03),
    slippageEdgeFrac: num("EXEC_SLIPPAGE_EDGE_FRAC", 0.15),
    crashDropFrac: num("EXEC_CRASH_DROP_FRAC", 0.35),
    lossHaltCount: num("EXEC_LOSS_HALT_COUNT", 3),
    skipForecastTemplate:
      (process.env.EXEC_SKIP_FORECAST_TEMPLATE ?? "off").trim().toLowerCase() === "on",
    forecastMinPrice: num("EXEC_FORECAST_MIN_PRICE", 0.3),
    forecastLive: (process.env.EXEC_FORECAST_LIVE ?? "off").trim().toLowerCase() === "on",
    haltFile: rel(process.env.EXEC_HALT_FILE?.trim() || "data/trading-halt"),
    ledger: rel(process.env.EXEC_LEDGER?.trim() || "data/trade-ledger.jsonl"),
  };
}

// ── Ledger ──

/** 同一 attemptId 的多行(intent → 终态)只保留最后一行:终态行取代 intent
 * 的额度口径;没有终态行的孤儿 intent(进程死在 postOrder 在途窗口)原样保留,
 * 以 posted:"unknown" 保守占额并封锁该 token 去重。 */
export function collapseAttempts<T extends Pick<LedgerEntry, "attemptId">>(entries: T[]): T[] {
  const lastIdx = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.attemptId) lastIdx.set(e.attemptId, i);
  });
  return entries.filter((e, i) => !e.attemptId || lastIdx.get(e.attemptId) === i);
}

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // 半行(崩溃截断)容忍:append-only,坏行不影响后续
    }
  }
  return collapseAttempts(out);
}

function appendLedger(ledgerPath: string, entry: LedgerEntry): void {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

/** 单条 ledger 记录当前占用的资金(P0-1 额度口径)。
 * 实际成交按 filledUsd(partial 只占实际成交部分);posted="unknown"
 * (postOrder 超时,交易所可能已受理)保守按 requestedUsd;FAK 零成交
 * (status=none)与明确拒单(status=error 且 posted=true)实际花 $0,不占额度
 * —— 修复前它们按 requestedUsd 终身累计,8 次尝试即打满 totalMax,引擎静默停机。 */
export const exposedUsd = (
  e: Pick<LedgerEntry, "mode" | "probe" | "posted" | "filledUsd" | "requestedUsd">
): number => {
  if (e.mode !== "live" || e.probe) return 0;
  if (e.posted === "unknown") return e.requestedUsd ?? 0;
  if (e.posted !== true) return 0;
  return e.filledUsd ?? 0;
};

/** postOrder 响应的传输层歧义判定(审计 2026-07-11 §1):clob-client-v2 对纯
 * 网络错误(ECONNRESET/socket hang up,请求可能已送达并成交)不 throw,返回
 * {error} 且无 status/orderID;真拒单必带 HTTP status(探针实测 400+orderID)。
 * 歧义结果不是拒单,必须按 posted:"unknown" 保守占额,否则是重复买入路径。 */
export const isTransportAmbiguous = (
  resp: { error?: unknown; status?: unknown; orderID?: unknown } | null | undefined,
  haveFill: boolean
): boolean => !haveFill && resp?.error != null && resp?.status == null && resp?.orderID == null;

/** 上行漂移容忍带(§2.3):绝对带在低价位是过窄的相对档 —— 肥尾回归途中
 * 0.164→0.20 仍 +400% EV 却被 0.03 绝对带拒单。带宽按剩余边(1−signalAsk)
 * 缩放,高价位退化回绝对带(只放宽低价位,绝不收紧既有行为)。 */
export const upDriftBand = (signalAsk: number, slippage: number, edgeFrac: number): number =>
  Math.max(slippage, edgeFrac * (1 - signalAsk));

/** 下行暴跌阈值(§2.3 对称侧):freshAsk 跌破信号价这么多 = 市场把裁定读成了
 * 反方向,此刻的"便宜"是毒饵 —— skip 待人工复核,不能当折扣照买。 */
export const crashDropThreshold = (signalAsk: number, slippage: number, dropFrac: number): number =>
  Math.max(slippage, dropFrac * signalAsk);

/** 实收 taker 费(Fee Structure V2,2026-03-30 起 8 品类实收):买入侧
 * fee = shares×rate×p×(1−p) = filledUsd×rate×(1−p)。feesEnabled=false → $0;
 * 费率未知(注解缺失/字段不可信)按平费 0.002 保守近似 —— 与 paper 侧
 * takerFeePct 的 config.feePct 兜底同源,宁多计不少计。 */
export const takerFeeUsd = (
  filledUsd: number,
  avgPrice: number,
  feesEnabled: boolean | null | undefined,
  feeRate: number | null | undefined
): number => {
  if (feesEnabled === false) return 0;
  const frac =
    feesEnabled === true && feeRate != null && Number.isFinite(feeRate) && feeRate >= 0 && feeRate <= 0.2
      ? feeRate * (1 - avgPrice)
      : 0.002;
  return Math.round(filledUsd * frac * 100) / 100;
};

/** 更正翻向双腿保护(§7):同 conditionId 已有敞口但 tokenId 不同 = 买对手边,
 * 两腿结算合计 ≤ $1,确定性锁损。返回冲突的已有持仓条目。 */
export const findOppositeLeg = <
  T extends Pick<LedgerEntry, "conditionId" | "tokenId" | "mode" | "probe" | "posted" | "filledUsd" | "requestedUsd">,
>(
  ledger: T[],
  conditionId: string | undefined,
  tokenId: string
): T | undefined =>
  conditionId
    ? ledger.find((e) => e.conditionId === conditionId && e.tokenId !== tokenId && exposedUsd(e) > 0)
    : undefined;

/** pUSD(Polymarket V2 抵押品,USDC 语义,6 位小数)。 */
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

/** proxy 钱包的 pUSD 可用余额(链上直读,fail-open:RPC 不可达返回 null,
 * 调用方照常下单,由 CLOB 侧最终把关)。持仓占满现金后每个绿单都会变
 * error→3 次误熔断,这里提前降为 skipped 告警(§7)。 */
async function proxyUsdcBalance(funder: string): Promise<number | null> {
  try {
    const data = `0x70a08231${funder.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const result = await withTimeout(ethCall(PUSD_ADDRESS, data, 8_000), 8_000, "pUSD balanceOf");
    return Number(BigInt(result)) / 1e6;
  } catch {
    return null;
  }
}

// ── 结算缓存(P0-1③ 敞口核销 + P0-4 结算对账共用,ledger 同目录 trade-settled.json)──

/** 缓存值:旧格式是纯 ISO 字符串(仅表示已结算),P0-4 起升级为对象并携带
 * 已实现盈亏;读取端两种都接受(sufe 上存在旧格式存量,truthy 即已结算)。
 * 保留键 "_lossHaltAt"(字符串)记录上次连亏熔断时刻,与 conditionId 不冲突。 */
interface SettledRecord {
  at: string;
  question?: string;
  outcome?: string;
  /** 我方 outcome 的结算价(赢=1/输=0,Gamma outcomePrices)。 */
  outcomePrice?: number;
  costUsd?: number;
  payoutUsd?: number;
  /** 已实现盈亏;无法可靠计算(无成交明细/outcome 未匹配)时缺失 ——
   * 缺失条目不进连亏熔断链(错的盈亏比没有盈亏更毒)。 */
  pnlUsd?: number;
  won?: boolean;
  /** 结算价已终局但 pnl 确认算不出(outcome 不匹配/无成交明细):terminal,
   * 不再重探。缺此标记且缺 pnlUsd 的对象 = 修复前冻结的未定型记录,要重探。 */
  pnlUnavailable?: boolean;
  /** 结算邮件已成功发出(markSettlementsNotified 置位)。 */
  notified?: boolean;
}
type SettledCache = Record<string, string | SettledRecord>;

/** 结算记录是否终局(审计 2026-07-11 §4):legacy 字符串(旧格式,视为已结)、
 * 带 pnl、或已确认 pnl 不可算。非终局对象(修复前在结算价未定型时就永久落盘
 * 的记录)既不释放敞口、也要继续重探,否则该持仓的真实亏损永远进不了连亏
 * 熔断链、敞口在钱仍在风险中时被提前放出。 */
export const settledFinal = (v: string | SettledRecord | undefined): boolean =>
  typeof v === "string" ? true : v != null && (v.pnlUsd != null || v.pnlUnavailable === true);

function settledCachePath(cfg: ReturnType<typeof execConfig>): string {
  return path.join(path.dirname(cfg.ledger), "trade-settled.json");
}

function loadSettledCache(cfg: ReturnType<typeof execConfig>): SettledCache {
  const p = settledCachePath(cfg);
  if (!existsSync(p)) return {}; // 首次运行,不是损坏
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // 损坏静默清零 = 连亏水位/已通知标记全丢:连亏熔断链断裂 + 结算邮件整批
    // 重发。仍按 {} 继续(fail-open,重查能自愈),但必须留下响声。
    console.error(
      `[trade-executor] trade-settled.json 损坏,按空缓存重查(连亏水位已丢失): ${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }
}

function saveSettledCache(cfg: ReturnType<typeof execConfig>, cache: SettledCache): void {
  try {
    // 连亏水位/结算通知的事实源:裸 writeFileSync 在崩溃/断电时留半截 JSON,
    // 下次 load 静默清零。writeFileAtomic(临时文件+rename)保证旧新二选一。
    writeFileAtomic(settledCachePath(cfg), JSON.stringify(cache, null, 1));
  } catch {
    // 缓存写失败只是下次重查,不影响本次口径
  }
}

/** 按 Gamma 结算价计算一组同 conditionId 持仓的已实现盈亏。只统计有成交明细
 * (filledUsd/filledShares)的条目;outcome 在 outcomes 里匹配不上时返回 null
 * —— 记结算但不记盈亏,宁缺毋错。cost 含成交时记账的实收 taker 费(feeUsd,
 * 2026-07-19 审查 §2:不含费的 won/连亏链系统性偏乐观;存量无 feeUsd 行按 0)。 */
export function computeSettlementPnl(
  entries: Array<Pick<LedgerEntry, "outcome" | "filledUsd" | "filledShares" | "feeUsd">>,
  outcomes: string[],
  outcomePrices: number[]
): { costUsd: number; payoutUsd: number; pnlUsd: number; won: boolean; outcomePrice: number } | null {
  const lower = outcomes.map((o) => o.toLowerCase().trim());
  let cost = 0;
  let payout = 0;
  let price: number | null = null;
  for (const e of entries) {
    if (!((e.filledUsd ?? 0) > 0) || !((e.filledShares ?? 0) > 0)) continue;
    const idx = e.outcome ? lower.indexOf(e.outcome.toLowerCase().trim()) : -1;
    const p = idx >= 0 ? outcomePrices[idx] : NaN;
    if (!Number.isFinite(p)) return null;
    cost += e.filledUsd! + (e.feeUsd ?? 0);
    payout += e.filledShares! * p;
    price = p;
  }
  if (price == null) return null; // 无成交明细,无盈亏可记
  return {
    costUsd: Math.round(cost * 100) / 100,
    payoutUsd: Math.round(payout * 100) / 100,
    pnlUsd: Math.round((payout - cost) * 100) / 100,
    won: payout >= cost,
    outcomePrice: price,
  };
}

interface GammaMarketView {
  conditionId?: string;
  closed?: boolean;
  umaResolutionStatus?: string | null;
  question?: string;
  outcomes?: unknown;
  outcomePrices?: unknown;
}

async function fetchGammaByCid(cid: string, extraQuery: string): Promise<GammaMarketView | null> {
  const res = await fetch(`${GAMMA_API}/markets?condition_ids=${cid}${extraQuery}&limit=2`, {
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) return null;
  const arr = (await res.json()) as GammaMarketView[] | null;
  return (
    (Array.isArray(arr) ? arr : []).find((x) => x.conditionId?.toLowerCase() === cid.toLowerCase()) ??
    null
  );
}

/** 单个 conditionId 的结算探测与记账:已结算 → 写入缓存(结算价已定型到
 * 0/1 时附带已实现盈亏),返回 true;Gamma 打不通或未结算返回 false。
 * 注意查询策略(2026-07-11 实测):`condition_ids=` 默认对已关闭市场返回空
 * ——必须带 `closed=true` 才能查到(原 P0-1③ 核销查询因此从未真正命中过,
 * 已结算敞口实际从不释放);resolved 但尚未 closed 的过渡态走默认查询。 */
async function probeAndRecordSettlement(
  cid: string,
  ledger: LedgerEntry[],
  cache: SettledCache
): Promise<boolean> {
  try {
    let m = await fetchGammaByCid(cid, "&closed=true");
    if (!m) {
      const openView = await fetchGammaByCid(cid, "");
      if (openView?.umaResolutionStatus?.trim().toLowerCase() === "resolved") m = openView;
    }
    if (!m) return false;
    const parseArr = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.map(String);
      try {
        const p = JSON.parse(String(v));
        return Array.isArray(p) ? p.map(String) : [];
      } catch {
        return [];
      }
    };
    const outcomes = parseArr(m.outcomes);
    const prices = parseArr(m.outcomePrices).map(Number);
    const entries = ledger.filter((e) => e.conditionId === cid && exposedUsd(e) > 0);
    // closed 可先于赔付价定型出现(如 0.999 过渡态、UMA 争议中)。未定型一律
    // 不落缓存(审计 2026-07-11 §4):敞口不释放(钱仍在风险中)、下轮继续重探
    // —— 修复前这里落永久无 pnl 记录,dispute 市场的真实亏损被终身冻结在连亏
    // 熔断链之外。
    const finalized = prices.length > 0 && prices.every((p) => p <= 0.005 || p >= 0.995);
    if (!finalized) return false;
    const pnl = computeSettlementPnl(entries, outcomes, prices);
    cache[cid] = {
      at: new Date().toISOString(),
      question: (m.question ?? entries[0]?.question)?.slice(0, 120),
      outcome: entries[0]?.outcome,
      // pnl 确认算不出(outcome 不匹配/无成交明细):terminal 标记,防止无限重探
      // + 每轮重发"无法计算"邮件。
      ...(pnl ?? { pnlUnavailable: true }),
      notified: false,
    };
    return true;
  } catch {
    return false; // 单个查询失败:该持仓本次按未结算计,下次再查
  }
}

/** P0-1③:totalMax 的口径是「当前未结算持仓」。按 conditionId 探测 Gamma
 * 结算状态,已结算的敞口核销释放(顺带记账盈亏,供 P0-4 结算对账通知);
 * 结算状态单调不可逆,Gamma 打不通或预算耗尽时剩余持仓保守按未结算计。 */
async function openExposureUsd(
  ledger: LedgerEntry[],
  cfg: ReturnType<typeof execConfig>,
  deadlineMs: number
): Promise<number> {
  const open = ledger.filter((e) => exposedUsd(e) > 0);
  if (open.length === 0) return 0;
  const cache = loadSettledCache(cfg);
  const pending = [
    ...new Set(open.map((e) => e.conditionId).filter((c): c is string => !!c && !settledFinal(cache[c]))),
  ];
  let dirty = false;
  for (const cid of pending) {
    if (Date.now() >= deadlineMs) break; // 预算耗尽:剩余按未结算计,宁少放行不超敞口
    if (await probeAndRecordSettlement(cid, ledger, cache)) dirty = true;
  }
  if (dirty) saveSettledCache(cfg, cache);
  return open
    .filter((e) => !(e.conditionId && settledFinal(cache[e.conditionId])))
    .reduce((s, e) => s + exposedUsd(e), 0);
}

// ── P0-4:结算对账 + 连亏熔断 ──

/** 落 kill-switch 文件(自动熔断共用;尽力而为,创建失败只能 loud-log)。 */
function haltTrading(cfg: Pick<ReturnType<typeof execConfig>, "haltFile">, reason: string): void {
  try {
    mkdirSync(path.dirname(cfg.haltFile), { recursive: true });
    writeFileSync(
      cfg.haltFile,
      `auto-halt ${new Date().toISOString()}: ${reason}\n人工排查后删除本文件恢复。\n`
    );
    console.error(`[trade-executor] 已自动创建 kill-switch ${cfg.haltFile}: ${reason}`);
  } catch (err) {
    console.error(
      `[trade-executor] kill-switch 创建失败(${err instanceof Error ? err.message : String(err)}),原因: ${reason}`
    );
  }
}

/** 结算链尾部的连亏笔数(按结算检出时间升序看尾巴)。盈亏未知的条目跳过、
 * 不断链 —— 未知不该稀释「系统性买错」的证据。 */
export function consecutiveLossTail(records: Array<{ at: string; pnlUsd?: number }>): number {
  const ordered = [...records].sort((a, b) => a.at.localeCompare(b.at));
  let n = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const pnl = ordered[i].pnlUsd;
    if (pnl == null) continue;
    if (pnl < -0.01) n += 1;
    else break;
  }
  return n;
}

/** 连亏熔断条件评估(reconcile 与 executeSignal 执行前闸共用,审计 2026-07-11
 * §7):尾亏 ≥ 阈值,且最近一笔有盈亏的结算晚于上次熔断水位 "_lossHaltAt"
 * (操作员删 halt 恢复后,除非有新亏损落地,同一段历史不重复熔断)。 */
export function lossHaltTripped(
  cache: SettledCache,
  lossHaltCount: number
): { losses: number; tripped: boolean } {
  const records = Object.values(cache).filter(
    (v): v is SettledRecord => typeof v === "object" && v !== null
  );
  const losses = consecutiveLossTail(records);
  const lastHaltMark = typeof cache["_lossHaltAt"] === "string" ? (cache["_lossHaltAt"] as string) : "";
  const lastPnlRec = records
    .filter((r) => r.pnlUsd != null)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  return { losses, tripped: losses >= lossHaltCount && !!lastPnlRec && lastPnlRec.at > lastHaltMark };
}

export interface SettlementEvent {
  conditionId: string;
  question: string | null;
  outcome: string | null;
  costUsd: number | null;
  payoutUsd: number | null;
  pnlUsd: number | null;
  won: boolean | null;
  at: string;
}

/**
 * 结算对账(P0-4):探测 ledger 里仍有敞口持仓的 Gamma 结算状态,按结算价记
 * 已实现盈亏;连亏 ≥ EXEC_LOSS_HALT_COUNT 笔自动落 halt(修复前 autoHalt 只认
 * status=error,连亏 8 笔 -$800 也不触发任何防线)。返回待通知事件(含既往
 * 发信失败的重试);无持仓且无待通知时返回 null(零网络调用)。调用方发信
 * 成功后必须调 markSettlementsNotified,否则每 tick 重复通知。
 * 同一轮连亏只熔断一次("_lossHaltAt" 水位):操作员删 halt 恢复后,除非有
 * 新亏损落地,不会被同一段历史立刻再次熔断。
 */
export async function reconcileSettlements(budgetMs: number): Promise<{
  events: SettlementEvent[];
  consecutiveLosses: number;
  lossHalted: boolean;
} | null> {
  const cfg = execConfig();
  const ledger = readLedger(cfg.ledger).filter((e) => e.mode === "live" && !e.probe);
  const cache = loadSettledCache(cfg);
  const pendingNotify = (): Array<[string, SettledRecord]> =>
    Object.entries(cache).filter(
      (kv): kv is [string, SettledRecord] => typeof kv[1] === "object" && kv[1].notified === false
    );
  const open = ledger.filter(
    (e) => exposedUsd(e) > 0 && e.conditionId && !settledFinal(cache[e.conditionId])
  );
  if (open.length === 0 && pendingNotify().length === 0) return null;

  const deadline = Date.now() + Math.max(0, budgetMs);
  let dirty = false;
  for (const cid of [...new Set(open.map((e) => e.conditionId!))]) {
    if (Date.now() >= deadline) break;
    if (await probeAndRecordSettlement(cid, ledger, cache)) dirty = true;
  }

  const { losses, tripped } = lossHaltTripped(cache, cfg.lossHaltCount);
  let lossHalted = false;
  if (tripped) {
    if (!existsSync(cfg.haltFile)) {
      haltTrading(
        cfg,
        `结算对账连亏 ${losses} 笔(阈值 ${cfg.lossHaltCount}),疑似系统性误判;明细见 ${settledCachePath(cfg)}`
      );
    }
    cache["_lossHaltAt"] = new Date().toISOString();
    dirty = true;
    lossHalted = true;
  }
  if (dirty) saveSettledCache(cfg, cache);

  const events: SettlementEvent[] = pendingNotify().map(([cid, r]) => ({
    conditionId: cid,
    question: r.question ?? null,
    outcome: r.outcome ?? null,
    costUsd: r.costUsd ?? null,
    payoutUsd: r.payoutUsd ?? null,
    pnlUsd: r.pnlUsd ?? null,
    won: r.won ?? null,
    at: r.at,
  }));
  return { events, consecutiveLosses: losses, lossHalted };
}

/** 结算通知已成功送达 —— 置位 notified(at-least-once 的收尾)。 */
export function markSettlementsNotified(conditionIds: string[]): void {
  const cfg = execConfig();
  const cache = loadSettledCache(cfg);
  let dirty = false;
  for (const cid of conditionIds) {
    const r = cache[cid];
    if (r && typeof r === "object" && r.notified === false) {
      r.notified = true;
      dirty = true;
    }
  }
  if (dirty) saveSettledCache(cfg, cache);
}

// ── CLOB client(进程内单例;chain-watch 每 tick 一个进程)──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;

/** 已配置三元组(signer/funder/POLY_1271)与缓存 L2 creds 的 CLOB client。
 * 供 executeSignal 与 exec-selftest 共用;失败不缓存,下次调用重试。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getExecClient(): Promise<any> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const cfg = execConfig();
    // 动态 import:执行器依赖缺失/损坏时只废掉执行,绝不拖垮 chain-watch 告警主路径
    const [{ ClobClient, SignatureTypeV2 }, { Wallet }] = await Promise.all([
      import("@polymarket/clob-client-v2"),
      import("@ethersproject/wallet"),
    ]);
    const { privateKey } = JSON.parse(readFileSync(cfg.walletJson, "utf8")) as { privateKey: string };
    const wallet = new Wallet(privateKey);
    let creds: { key: string; secret: string; passphrase: string } | null = null;
    try {
      creds = JSON.parse(readFileSync(cfg.credsJson, "utf8"));
    } catch {
      // 首次运行:L1 签名派生 L2 creds 并缓存(约 0.5s,此后免掉)
    }
    if (!creds?.key) {
      const boot = new ClobClient({ host: CLOB_API, chain: 137, signer: wallet });
      creds = await boot.createOrDeriveApiKey();
      mkdirSync(path.dirname(cfg.credsJson), { recursive: true });
      writeFileSync(cfg.credsJson, JSON.stringify(creds, null, 1));
      chmodSync(cfg.credsJson, 0o600);
    }
    return new ClobClient({
      host: CLOB_API,
      chain: 137,
      signer: wallet,
      creds,
      funderAddress: cfg.funder,
      signatureType: SignatureTypeV2.POLY_1271,
    });
  })();
  clientPromise.catch(() => {
    clientPromise = null; // 失败不缓存,下次(下个 tick)重试
  });
  return clientPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ── 主入口 ──

/**
 * Execute (or dry-run) a BUY of the signal's directional outcome token.
 * Never throws. Always appends a ledger entry except for pure config-off.
 */
export async function executeSignal(input: TradeSignalInput): Promise<TradeAttempt> {
  const t0 = Date.now();
  const cfg = execConfig();
  const mode = executionMode();
  /** live 路径下单前置位;此后所有终态行(含 catch 兜底)带同一 attemptId,
   * 在 readLedger 处取代 write-ahead intent 行。 */
  let liveAttemptId: string | undefined;
  const finish = (a: TradeAttempt, raw?: unknown): TradeAttempt => {
    a.latencyMs = Date.now() - t0;
    try {
      appendLedger(cfg.ledger, {
        at: new Date().toISOString(),
        qid: input.qid,
        tokenId: input.tokenId,
        conditionId: input.conditionId,
        outcome: input.outcome,
        question: input.question?.slice(0, 160),
        label: input.label,
        stance: input.stance,
        llmStance: input.llmStance ?? null,
        llmConfidence: input.llmConfidence ?? null,
        signalAsk: input.bestAskAtSignal,
        ...(input.dirMethod ? { dirMethod: input.dirMethod } : {}),
        ...(input.probe ? { probe: true } : {}),
        ...(liveAttemptId ? { attemptId: liveAttemptId } : {}),
        ...a,
        ...(raw !== undefined ? { raw } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[trade-executor] ledger 写入失败: ${msg}`);
      // P0-3 fail-closed:ledger 是去重与全部额度的唯一事实源。写不进去(磁盘
      // 满/权限)还继续跑 = 下个 tick 看不到本次记录,同一信号每 3 分钟重复
      // 实弹买入 —— 全系统唯一无上限亏损路径。写失败即落 kill-switch。
      if (mode === "live") {
        haltTrading(cfg, `ledger 写入失败(${msg})——去重/额度事实源不可用,fail-closed`);
        a.subjectAlert = a.subjectAlert ?? "ledger写失败已停机";
        a.reason = `${a.reason ? `${a.reason}; ` : ""}ledger 写入失败,已自动落 kill-switch`;
      }
    }
    return a;
  };

  if (mode === "off") return { mode, status: "skipped", reason: "EXEC_MODE=off" };

  try {
    // ── 风控闸(全部在任何网络调用之前)──
    if (existsSync(cfg.haltFile)) {
      return finish({ mode, status: "skipped", reason: `kill-switch 存在(${cfg.haltFile})` });
    }
    if (input.budgetMs < 12_000) {
      return finish({ mode, status: "skipped", reason: `tick 预算不足(${Math.round(input.budgetMs / 1000)}s)` });
    }
    // ── 预告模板家族闸门制(2026-07-14 官方行为研究 §7.2)──
    // 一刀切 skip 改三闸门:重放 15 个月,三闸门 16 笔全胜 +$194,C0 无闸裸
    // 执行 −$195(未到期快照雷全踩)。闸3 owner 白名单在 chain-watch 事件层
    // (非官方 owner 的 context 不进判读/执行路径),此处是闸1/闸2。
    if (input.forecastTemplate) {
      if (cfg.skipForecastTemplate) {
        return finish({ mode, status: "skipped", reason: "预告模板家族(EXEC_SKIP_FORECAST_TEMPLATE=on,旧一刀切口径)" });
      }
      // 闸1 boundary(核心):落地为 leans ∧ 事件窗口未确认已决 —— 与 tiering
      // 的 boundaryPending 同语义,在执行侧做成硬拦截(tiering 侧只降档,且
      // LLM_BOUNDARY_GUARD 可被关掉;-100% 级快照雷全部是此形态)。
      // fail-closed(2026-07-19 审查 §10):eventStatus=null 是 llmStance 设计内
      // 状态(v3 回复/字段缺失),原 === "pending" 对 null/unclear 放行 ——
      // 硬闸对"未知"放行等于没闸。只有明确 decided 才过。
      if (
        input.llmEventStatus !== "decided" &&
        (/^leans_/i.test(input.llmStance ?? "") || /^leans_/i.test(input.stance))
      ) {
        return finish({
          mode,
          status: "skipped",
          reason: `预告家族boundary闸:leans∧事件未确认已决(eventStatus=${input.llmEventStatus ?? "null"};快照雷形态,重放中无此闸家族净亏−$195;null/unclear 一律 fail-closed)`,
        });
      }
      // 闸2 防雷:方向侧信号价 <0.30 = 市场不跟随澄清方向(文本可疑/姊妹盘
      // 错配形态),不执行。freshAsk 侧同样按此地板(下方盘口检查)。
      if (input.bestAskAtSignal != null && input.bestAskAtSignal < cfg.forecastMinPrice) {
        return finish({
          mode,
          status: "skipped",
          reason: `预告家族防雷闸:信号价 ${input.bestAskAtSignal.toFixed(3)} < ${cfg.forecastMinPrice}(市场不跟随澄清方向,文本可疑/姊妹盘错配)`,
        });
      }
      // paper 验证期:三闸门通过后 live 也暂不实弹,先验证闸门在线上判读口径
      // 下的表现(4-6 周);ledger 落 skipped 行留痕,paper_trades 照常独立登记。
      if (mode === "live" && !cfg.forecastLive) {
        return finish({
          mode,
          status: "skipped",
          reason: "预告家族三闸门通过 — paper 验证期(EXEC_FORECAST_LIVE=off),本单不实弹;验证期后置 on 放开",
        });
      }
    }

    const ledger = readLedger(cfg.ledger);
    let dailyLeft = cfg.maxOrderUsd;
    let totalLeft = cfg.maxOrderUsd;
    if (!input.probe) {
      // 漂移防护前置条件(审计 2026-07-11 §5):注解时无盘口基准 = 上行漂移带、
      // 下行暴跌守卫、tiering 的 M2 逆共识红旗全部失效(它们都以 bestAskAtSignal
      // 为锚)。这类信号只发信人工确认,不自动执行。
      if (input.bestAskAtSignal == null) {
        // 空盘与注解异常分口径(2026-08-01 飓风家族复盘):空盘 = CLOB book
        // (全镜像,含对侧腿)无任何卖侧挂单,taker 任何价位均不可成交,人工
        // 手动下单同样无从成交 —— 不再误导性地喊人工;注解异常才需要人工核对。
        if (input.bookEmpty) {
          return finish({
            mode,
            status: "skipped",
            reason: "盘口无卖侧挂单(空盘,CLOB book 含镜像对侧)—— taker 任何价位不可成交,人工亦无从下单;吃此腿唯 maker 挂单(策略层,未开)",
            subjectAlert: "空盘不可成交",
          });
        }
        return finish({
          mode,
          status: "skipped",
          reason: "信号注解无盘口基准(bestAskAtSignal=null:book 未拉取/响应异常/首轮锚缺失),漂移带/暴跌守卫/M2 红旗不可用 — 人工确认后手动下单",
          subjectAlert: "无盘口基准",
        });
      }
      // 连亏熔断前置检查(审计 2026-07-11 §7):对账在 tick 末才跑,不前置则
      // 隔夜已定型的连亏拦不住本 tick 的新绿单(阈值实际 N+1)。零网络调用,
      // 只读本地结算缓存;水位推进与 ⛔ 通知仍归 reconcile 侧,这里只落 halt
      // 文件并拦下本单。
      if (mode === "live") {
        const lh = lossHaltTripped(loadSettledCache(cfg), cfg.lossHaltCount);
        if (lh.tripped) {
          if (!existsSync(cfg.haltFile)) {
            haltTrading(cfg, `结算连亏 ${lh.losses} 笔(阈值 ${cfg.lossHaltCount},执行前置检查)`);
          }
          return finish({
            mode,
            status: "skipped",
            reason: `结算连亏 ${lh.losses} 笔 ≥ 阈值 ${cfg.lossHaltCount},已落 kill-switch`,
            subjectAlert: "连亏熔断⛔",
          });
        }
      }
      // 去重只看「有敞口」的条目(P0-1):确认零成交(none)与明确拒单不封锁
      // token,否则一次 FAK 无对手盘就永久放弃该市场的后续机会。
      const dup = ledger.find(
        (e) =>
          e.tokenId === input.tokenId &&
          !e.probe &&
          (exposedUsd(e) > 0 || (mode === "dry" && e.mode === "dry" && e.status === "dry"))
      );
      if (dup) {
        // P1 快轮询邮件失败重试会整段重放到这里(审计 2026-07-11 §8):重试轮
        // 送达的邮件是这条 skipped —— 不带持仓信息的话,真实成交会被呈现成
        // "未下单"。把已持仓状态升到主题级。
        const held =
          dup.status === "filled" || dup.status === "partial"
            ? `,已成交 $${(dup.filledUsd ?? 0).toFixed(2)}${dup.avgPrice != null ? ` @均价 ${dup.avgPrice}` : ""}`
            : dup.posted === "unknown"
              ? ",下单结果未知(保守按持仓计)"
              : "";
        return finish({
          mode,
          status: "skipped",
          reason: `已对该 token 执行过(${dup.at} ${dup.status}${held})`,
          ...(dup.status === "filled" || dup.status === "partial"
            ? { subjectAlert: `已持仓$${Math.round(dup.filledUsd ?? 0)}` }
            : dup.posted === "unknown"
              ? { subjectAlert: "持仓状态未知" }
              : {}),
        });
      }
      // §7 翻向双腿保护:correction 翻向(或任何原因)对同市场反向腿下单 =
      // 确定性锁损。已有敞口时一律 skip + 主题级告警,人工决定是否对冲/换腿。
      const opposite = findOppositeLeg(ledger, input.conditionId, input.tokenId);
      if (opposite) {
        return finish({
          mode,
          status: "skipped",
          reason: `同市场已持反向腿 ${opposite.outcome ?? opposite.tokenId.slice(0, 10)}(${opposite.at});${
            input.correction ? "更正裁定翻向" : "翻向"
          }买入=双腿锁损,需人工处理`,
          subjectAlert: "翻向双腿⚠",
        });
      }
      const today = new Date().toISOString().slice(0, 10);
      const spentToday = ledger
        .filter((e) => e.at?.slice(0, 10) === today)
        .reduce((s, e) => s + exposedUsd(e), 0);
      if (mode === "live" && spentToday >= cfg.dailyMaxUsd) {
        return finish({
          mode,
          status: "skipped",
          reason: `日额度已满($${spentToday.toFixed(0)}/${cfg.dailyMaxUsd})`,
          subjectAlert: "日额度满",
        });
      }
      // totalMax = 当前未结算持仓(P0-1③)。毛敞口未触顶时走快路径(零网络
      // 调用);触顶才做 Gamma 结算核销,把已结算持仓从口径中释放。
      let openTotal = ledger.reduce((s, e) => s + exposedUsd(e), 0);
      if (mode === "live" && openTotal >= cfg.totalMaxUsd) {
        openTotal = await openExposureUsd(
          ledger,
          cfg,
          Date.now() + Math.min(12_000, Math.max(0, input.budgetMs - 15_000))
        );
        if (openTotal >= cfg.totalMaxUsd) {
          return finish({
            mode,
            status: "skipped",
            reason: `未结算持仓已满($${openTotal.toFixed(0)}/${cfg.totalMaxUsd})`,
            subjectAlert: "总敞口满",
          });
        }
      }
      dailyLeft = Math.max(0, cfg.dailyMaxUsd - spentToday);
      totalLeft = Math.max(0, cfg.totalMaxUsd - openTotal);
    }

    // ── 新鲜盘口(信号注解距此可能已过数十秒 LLM 判读)──
    const client = await withTimeout(getExecClient(), Math.min(15_000, input.budgetMs - 5_000), "client init");
    const book = (await withTimeout(
      client.getOrderBook(input.tokenId),
      8_000,
      "getOrderBook"
    )) as { asks?: Array<{ price: string; size: string }> };
    const asks = (book.asks ?? [])
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
      .sort((a, b) => a.price - b.price);
    const freshAsk = asks[0]?.price ?? null;
    if (freshAsk == null) {
      return finish({ mode, status: "skipped", reason: "盘口无卖单", freshAsk });
    }
    if (freshAsk > cfg.maxPrice) {
      return finish({
        mode,
        status: "skipped",
        reason: `ask ${freshAsk.toFixed(3)} > 上限 ${cfg.maxPrice}(尾价/已重定价)`,
        freshAsk,
      });
    }
    // 预告家族防雷闸在新鲜盘口上的同一地板(信号价过闸后价格仍可能塌下去)。
    const minPriceEff =
      input.forecastTemplate && !cfg.skipForecastTemplate
        ? Math.max(cfg.minPrice, cfg.forecastMinPrice)
        : cfg.minPrice;
    if (freshAsk < minPriceEff) {
      return finish({ mode, status: "skipped", reason: `ask ${freshAsk.toFixed(3)} < 下限 ${minPriceEff}`, freshAsk });
    }
    if (input.bestAskAtSignal != null) {
      // §2.3 漂移带按边缩放:上行容忍 max(slippage, edgeFrac×(1−signal))。
      const up = upDriftBand(input.bestAskAtSignal, cfg.slippage, cfg.slippageEdgeFrac);
      if (freshAsk > input.bestAskAtSignal + up) {
        return finish({
          mode,
          status: "skipped",
          reason: `信号后已重定价(注解 ${input.bestAskAtSignal.toFixed(3)} → 现 ${freshAsk.toFixed(3)},超漂移带 ${up.toFixed(3)})`,
          freshAsk,
        });
      }
      // §2.3 下行守卫:ask 暴跌 = 市场读出反方向,便宜是毒饵,不买、报警。
      const down = crashDropThreshold(input.bestAskAtSignal, cfg.slippage, cfg.crashDropFrac);
      if (freshAsk < input.bestAskAtSignal - down) {
        return finish({
          mode,
          status: "skipped",
          reason: `盘口反向暴跌(注解 ${input.bestAskAtSignal.toFixed(3)} → 现 ${freshAsk.toFixed(3)},超下行阈值 ${down.toFixed(3)}),市场可能读出反方向 — 人工复核`,
          freshAsk,
          subjectAlert: "盘口反向暴跌⚠",
        });
      }
    }

    const limitPrice = Math.min(
      Math.round((freshAsk + cfg.slippage) * 100) / 100,
      cfg.maxPrice,
      0.99
    );
    const depthUsd = asks
      .filter((l) => l.price <= limitPrice)
      .reduce((s, l) => s + l.price * l.size, 0);
    let orderUsd = Math.floor(Math.min(cfg.maxOrderUsd, dailyLeft, totalLeft, depthUsd * 0.9));
    if (orderUsd < cfg.minOrderUsd) {
      return finish({
        mode,
        status: "skipped",
        reason: `可用额度/限价内深度不足(可下 $${orderUsd},最低 $${cfg.minOrderUsd};深度 $${depthUsd.toFixed(0)})`,
        freshAsk,
        limitPrice,
      });
    }

    // negRisk 已知时传给 client 省一次串行往返;version/tickSize 让 client 自己
    // 解析(2026-04-28 V2 迁移一夜废掉全部旧 bot 的教训:版本绝不硬编码)。
    const orderOptions = input.negRisk !== undefined ? { negRisk: input.negRisk } : undefined;

    if (mode === "dry") {
      // 干跑也走完构单+签名(校验签名路径与参数),只差 postOrder
      const { Side, OrderType } = await import("@polymarket/clob-client-v2");
      await withTimeout(
        client.createMarketOrder(
          {
            tokenID: input.tokenId,
            price: limitPrice,
            amount: orderUsd,
            side: Side.BUY,
            orderType: OrderType.FAK,
          },
          orderOptions
        ),
        Math.min(30_000, input.budgetMs - 5_000),
        "createMarketOrder(dry)"
      );
      return finish({
        mode,
        status: "dry",
        reason: "EXEC_MODE=dry(已构单+签名,未提交)",
        freshAsk,
        limitPrice,
        requestedUsd: orderUsd,
        posted: false,
      });
    }

    // ── live ──
    // §7 下单前余额核查:USDC 被持仓占满后,不查余额的每个绿单都会变
    // error→3 次误熔断。链上直读 proxy 的 pUSD,不足即降额或 skip 告警;
    // RPC 不可达时 fail-open 照常下单(CLOB 侧最终把关)。
    {
      const balance = await proxyUsdcBalance(cfg.funder);
      if (balance != null) {
        if (balance < cfg.minOrderUsd) {
          return finish({
            mode,
            status: "skipped",
            reason: `proxy USDC 余额不足($${balance.toFixed(2)} < 最低 $${cfg.minOrderUsd})——持仓占满/待赎回?`,
            freshAsk,
            limitPrice,
            subjectAlert: "余额不足",
          });
        }
        if (balance < orderUsd) orderUsd = Math.floor(balance);
      }
    }
    const { Side, OrderType } = await import("@polymarket/clob-client-v2");
    const signed = await withTimeout(
      client.createMarketOrder(
        {
          tokenID: input.tokenId,
          price: limitPrice,
          amount: orderUsd,
          side: Side.BUY,
          orderType: OrderType.FAK,
        },
        orderOptions
      ),
      Math.min(30_000, input.budgetMs - 8_000),
      "createMarketOrder"
    );
    // ── write-ahead intent(审计 2026-07-11 §1)──
    // postOrder 一旦发出,结果在响应回来前对本进程是未知的:先落一条
    // posted:"unknown" 的 intent 行(按 requestedUsd 占额、封锁该 token 去重),
    // 终态行随后经同一 attemptId 在 readLedger 处取代它。进程死在在途窗口
    // (run-cron 170s SIGTERM/断电)时,孤儿 intent 保守把"可能已成交"当持仓,
    // 修复前这里是全系统唯一在成交后对所有防线不可见的窗口。
    liveAttemptId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    appendLedger(cfg.ledger, {
      at: new Date().toISOString(),
      qid: input.qid,
      tokenId: input.tokenId,
      conditionId: input.conditionId,
      outcome: input.outcome,
      question: input.question?.slice(0, 160),
      mode,
      status: "intent",
      posted: "unknown",
      requestedUsd: orderUsd,
      limitPrice,
      freshAsk,
      attemptId: liveAttemptId,
      ...(input.probe ? { probe: true } : {}),
    });

    // clob-client-v2 的 http 层从不 throw HTTP 错误:非 2xx 一律返回
    // {error: string|object, status: number}(2026-07-10 探针单实测)。
    let resp: {
      success?: boolean;
      errorMsg?: string;
      error?: unknown;
      orderID?: string;
      status?: string | number;
      takingAmount?: string;
      makingAmount?: string;
    };
    try {
      // 超时按剩余墙钟钳制:等不到响应就放弃等待(订单结果由 intent 行兜底),
      // 不把 20s 平坦超时硬顶进 SIGTERM 窗口。
      resp = await withTimeout(
        client.postOrder(signed, OrderType.FAK),
        Math.min(20_000, Math.max(5_000, input.budgetMs - (Date.now() - t0) - 2_000)),
        "postOrder"
      );
    } catch (err) {
      // 超时/传输层异常(ECONNRESET、代理中断):请求可能已到达交易所 ——
      // 一律 posted:"unknown" 保守占额。修复前非超时异常记 posted:false
      // (不占额、不封锁去重),是重复实弹买入路径。
      const msg = err instanceof Error ? err.message : String(err);
      const attempt = finish(
        {
          mode,
          status: "error",
          reason: `postOrder(结果未知): ${msg}`,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: "unknown",
          subjectAlert: "下单结果未知",
        },
        undefined
      );
      autoHaltOnRepeatedErrors(cfg);
      return attempt;
    }

    const shares = Number(resp?.takingAmount);
    const usd = Number(resp?.makingAmount);
    const haveFill = Number.isFinite(shares) && shares > 0 && Number.isFinite(usd) && usd > 0;
    const errStr =
      resp?.errorMsg ??
      (typeof resp?.error === "string"
        ? resp.error
        : resp?.error != null
          ? JSON.stringify(resp.error).slice(0, 200)
          : undefined);
    // 传输层歧义({error} 无 status/orderID = 请求可能已送达但响应丢失):
    // 不是拒单,posted:"unknown" 保守占额,结算核销时终局(审计 2026-07-11 §1)。
    if (isTransportAmbiguous(resp, haveFill)) {
      const attempt = finish(
        {
          mode,
          status: "error",
          reason: `postOrder 传输层错误(结果未知): ${errStr}`,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: "unknown",
          subjectAlert: "下单结果未知",
        },
        resp
      );
      autoHaltOnRepeatedErrors(cfg);
      return attempt;
    }
    // FAK 零成交即撤:交易所受理(有 orderID)但簿内无对手 —— 语义是"未成交",
    // 不是运维错误,不计入连续报错熔断(探针实测:error 文案 + status 400 + orderID)。
    if (!haveFill && errStr && /FAK order/i.test(errStr)) {
      return finish(
        {
          mode,
          status: "none",
          reason: `FAK 未成交即撤: ${errStr.slice(0, 120)}`,
          orderId: resp?.orderID,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: true,
        },
        resp
      );
    }
    // 终态分类缺口(2026-07-19 审查 §6):success=false 但响应带成交金额 =
    // 部分成交后被拒/撤(FAK 吃掉部分深度后余量无对手)。原第一析取不看
    // haveFill,这类会被记成"拒单 $0"—— 真金已花却不占额、不封锁去重,同
    // token 下轮重复买入(幽灵持仓)。按实际成交记账 + 主题告警。
    if (resp?.success === false && haveFill) {
      return finish(
        {
          mode,
          status: usd >= orderUsd * 0.95 ? "filled" : "partial",
          reason: `CLOB success=false 但含成交金额(按实际成交记账): ${errStr ?? ""}`.trim(),
          orderId: resp?.orderID,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          filledUsd: Math.round(usd * 100) / 100,
          filledShares: Math.round(shares * 100) / 100,
          avgPrice: Math.round((usd / shares) * 1000) / 1000,
          feeUsd: takerFeeUsd(usd, usd / shares, input.feesEnabled, input.feeRate),
          posted: true,
          subjectAlert: "拒单响应含成交⚠",
        },
        resp
      );
    }
    if (!haveFill && (resp?.success === false || errStr)) {
      // §8:资金不足是容量问题不是运维故障 —— 持仓占满现金的批量日,每个
      // 绿单都变 error,3 笔即误触发连续报错熔断把引擎停掉。记 skipped
      // (不进 autoHalt 尾链),主题级告警留给人工补钱/赎回。
      if (errStr && /insufficient|not enough|balance/i.test(errStr)) {
        return finish(
          {
            mode,
            status: "skipped",
            reason: `CLOB 拒单(余额不足): ${errStr.slice(0, 160)}`,
            orderId: resp?.orderID,
            freshAsk,
            limitPrice,
            requestedUsd: orderUsd,
            posted: true,
            subjectAlert: "余额不足",
          },
          resp
        );
      }
      // §6 相邻缺口:502/503/504 是网关错误,请求可能已到撮合后端 ——
      // 不是确定性拒单,按 posted:"unknown" 保守占额,结算核销时终局。
      const httpStatus = Number(resp?.status);
      if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
        const attempt = finish(
          {
            mode,
            status: "error",
            reason: `CLOB 网关错误 ${httpStatus}(结果未知): ${errStr ?? ""}`.trim(),
            freshAsk,
            limitPrice,
            requestedUsd: orderUsd,
            posted: "unknown",
            subjectAlert: "下单结果未知",
          },
          resp
        );
        autoHaltOnRepeatedErrors(cfg);
        return attempt;
      }
      const attempt = finish(
        {
          mode,
          status: "error",
          reason: `CLOB 拒单: ${errStr ?? JSON.stringify(resp).slice(0, 200)}`,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: true,
        },
        resp
      );
      autoHaltOnRepeatedErrors(cfg);
      return attempt;
    }
    if (!haveFill) {
      // FAK 受理但无成交金额:status=delayed/live 表示订单仍可能被撮合(撮合
      // 延迟市场),资金可能稍后被吃 —— 结果未知保守占额;只有明确终态才记
      // $0 的 none(审计 2026-07-11 §15)。
      const st = typeof resp?.status === "string" ? resp.status.toLowerCase() : "";
      if (st === "delayed" || st === "live") {
        return finish(
          {
            mode,
            status: "none",
            reason: `FAK 受理但撮合未终局(status=${resp?.status}),结果未知按持仓保守计`,
            orderId: resp?.orderID,
            freshAsk,
            limitPrice,
            requestedUsd: orderUsd,
            posted: "unknown",
            subjectAlert: "成交结果未知",
          },
          resp
        );
      }
      return finish(
        {
          mode,
          status: "none",
          reason: `FAK 未成交即撤(status=${resp?.status ?? "?"})`,
          orderId: resp?.orderID,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: true,
        },
        resp
      );
    }
    return finish(
      {
        mode,
        status: usd >= orderUsd * 0.95 ? "filled" : "partial",
        orderId: resp?.orderID,
        freshAsk,
        limitPrice,
        requestedUsd: orderUsd,
        filledUsd: Math.round(usd * 100) / 100,
        filledShares: Math.round(shares * 100) / 100,
        avgPrice: Math.round((usd / shares) * 1000) / 1000,
        feeUsd: takerFeeUsd(usd, usd / shares, input.feesEnabled, input.feeRate),
        posted: true,
      },
      resp
    );
  } catch (err) {
    const attempt = finish({
      mode,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      posted: false,
    });
    autoHaltOnRepeatedErrors(cfg);
    return attempt;
  }
}

/** 连续 3 次 live error → 自动落 kill-switch 文件(带原因),宁停不重复烧钱。
 * 计数窗口只看真正到达交易所的执行尝试(error/filled/partial/none):skipped
 * 是风控闸拦截、intent 是结果未知的孤儿行,都不代表执行链路健康 —— 让它们
 * 打断计数,持续性故障会因错误间穿插额度/盘口 skip 而永远凑不满 3 连
 * (审计 2026-07-11 §6)。人工删除该文件即恢复。 */
function autoHaltOnRepeatedErrors(cfg: ReturnType<typeof execConfig>): void {
  try {
    const attempts = readLedger(cfg.ledger).filter(
      (e) =>
        e.mode === "live" &&
        !e.probe &&
        (e.status === "error" || e.status === "filled" || e.status === "partial" || e.status === "none")
    );
    const tail = attempts.slice(-3);
    if (tail.length === 3 && tail.every((e) => e.status === "error")) {
      haltTrading(cfg, `连续 3 次 live 执行错误,详见 ${cfg.ledger} 尾部`);
    }
  } catch {
    // 自动熔断是尽力而为
  }
}
