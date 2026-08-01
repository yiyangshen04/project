/**
 * Chain-only dispute watcher — the degraded-network mode for remote boxes
 * that can reach Polygon RPCs but NOT gamma-api/clob (SNI-blocked, e.g. the
 * sufe deployment without a proxy).
 *
 * Every cron tick (default 3 min) it sweeps QuestionReset +
 * AncillaryDataUpdated events since the last tick, reads the question title
 * and official context straight from the chain, classifies the official
 * stance, and emails ONLY directional events (2026-07-08 narrowing — 97.3% of
 * raw dispute events carry no official direction and are not actionable):
 *   - regex-directional official context (the 32/32 signal class), or
 *   - regex-directionless text that a headless-Claude second read judges
 *     directional (catches definitional rulings; via=llm, quoted evidence).
 * Non-directional events still hit the log line and the notified-state
 * fingerprints; they come back through the gate when officials add text.
 *
 * Prices/depth (改进 I1, 2026-07-08): mailable items get a best-effort
 * executability annotation — qid→conditionId→Gamma→CLOB book via the box's
 * proxy — because the 15-month backtest showed 87% of directional alerts had
 * no $100 of real liquidity. The annotation is enrichment only: every
 * Gamma/CLOB failure degrades to the plain alert (title, official excerpt,
 * classified direction, search link). State (block cursor + notified set +
 * digest queue) lives in a JSON file; sqlite is used only opportunistically
 * for paper-trade registration (I6) and skipped where unavailable.
 *
 * bt5 标记点落地 (2026-07-10):
 *   P1 预告时点预埋 — 官方模板 "if a clarification is to be issued, it will
 *      be at X:00 PM ET" 兑现精度中位 +31s(79/80);解析承诺时点 → 📅 预警
 *      邮件(中位提前 1.55h)→ 承诺窗口内 tick 驻留快轮询(12s 间隔 ethCall
 *      storage 直读)→ 落地即 ⏰ 邮件。3min cron 对 ±31s 结构性失明的解法。
 *   P2 更正裁定 — "previous clarification was made in error" 是全部 6 例真
 *      方向翻转的统一形态;置顶展示+洪水豁免,即使无方向也放行。过双确认
 *      ∧high 闸的保留 🟢+🔄 注解并进 paper 登记,未过闸的 🔄 展示专用。
 *   P3 预告模板负向注解 — green∧预告家族均值 −5.5% 零肥尾,label-only。
 *   E1 dispute 风险标注 — 通知方向与 dispute 时点领先侧同向时标注事件级
 *      翻盘率 6.4-9.3%(扫描口径的 2-3 倍),只标不降档。
 *
 * Run: npx tsx scripts/chain-watch.ts
 * Env: ONCHAIN_RPC_URLS (comma-sep; default publicnode+1rpc), MAIL_* (mailer.ts),
 *      CHAIN_WATCH_STATE (default data/chain-watch-state.json),
 *      CHAIN_WATCH_PREARM=off (P1 总开关)
 */
import { readFileSync } from "fs";
import path from "path";
import { sendMail } from "./mailer";
import { ethCall } from "../lib/polymarket/oracleState";
import { getOfficialUpdates, isOfficialContextOwner, stanceFromText, detectRefundClause } from "../lib/polymarket/officialContext";
import type { OfficialUpdate } from "../lib/polymarket/officialContext";
import {
  parseScheduledClarification,
  matchesScheduledClarificationTemplate,
  detectCorrection,
} from "../lib/polymarket/clarificationSchedule";
import { classifyStanceWithLlm, llmCliCallCount, type LlmStanceVerdict } from "../lib/polymarket/llmStance";
import { checkExecutability, stancePolarity, type ExecCheck } from "../lib/polymarket/execCheck";
import {
  executeSignal,
  executionMode,
  execConfig,
  reconcileSettlements,
  markSettlementsNotified,
  type TradeAttempt,
} from "../lib/polymarket/tradeExecutor";
import { priorityOf as tierOf, isGreen, isFatTailShape, type TierVerdict } from "../lib/polymarket/tiering";
import { isDirectionalStance } from "../lib/virtualTags";
import { KNOWN_ADAPTERS } from "../lib/polymarket/onchainEvents";
import { guardHeadJump } from "../lib/polymarket/headGuard";
import { writeFileAtomic } from "../lib/fsAtomic";

/** Full HTML entity escape for any chain-sourced string spliced into email
 * body HTML. Market titles/context text come from permissionless on-chain
 * ancillary data (any third party controls them), so they must be escaped or
 * a creator can inject arbitrary HTML / phishing links into the alert. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 码点安全截断。String.slice 按 UTF-16 单元切,会切裂 emoji 代理对 —— 链上
 * 标题(敌手可控)的孤代理喂给 encodeURIComponent 直接抛 URIError,而且能把
 * 整个 tick 崩掉(审查确认:敌手可用第 80 位恰跨 emoji 的标题蓄意触发)。 */
function safeSlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

const TOPIC_QUESTION_RESET =
  "0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f";
const TOPIC_ANCILLARY_UPDATED =
  "0x0059e11815211969c0c4aaf3f498b52b6c2f2d14f286275d0862d70de22a836b";
const GET_QUESTION_SELECTOR = "0x58c039cd";

// Max lookback after downtime: ~3600 blocks ≈ 2 hours. publicnode only serves
// getLogs hugging the chain head (~127 blocks), so deeper pages fall through to
// the fallback RPCs (nodies/tenderly) that allow ~100-block windows at any
// depth. 3600 covers the largest gaps observed in production (2878 blocks);
// beyond it we accept the gap but ALWAYS email an alert (see gap handling
// below) so a permanent miss is never silent.
const HEAD_WINDOW = 3600;

// Confirmation depth: scan and advance the cursor only up to head-CONFIRMATIONS,
// not the unconfirmed latest head. A getLogs page that lands on a lagging RPC
// replica (or a shallow reorg) would otherwise return "success but missing the
// tail blocks" while the cursor sails past them — a permanent silent miss.
// ~25 blocks ≈ 50s on Polygon; the cost is that much extra notification delay.
const CONFIRMATIONS = 25;

// Sanity bound: on a non-first run, a single tick's head must not jump more
// than this past the stored cursor. A multi-chain gateway (e.g. 1rpc) can
// mis-route and return another chain's much higher block number; without this
// guard the cursor gets poisoned to that fake head and every later tick reports
// "no new blocks" while the channel is silently dead.
const MAX_HEAD_ADVANCE = 200_000; // ~4.8 days of Polygon blocks

// Per-tick sweep cap. A full HEAD_WINDOW catch-up is 75 sequential getLogs
// pages plus enrichment — that can overrun run-cron's 170s tick timeout, and
// since the cursor only commits at the end, a killed tick makes NO progress
// and the catch-up loops forever. Capping the sweep keeps every tick well
// inside its timeout; the remaining backlog carries to the next ticks
// (a full 3600-block window clears in 3 ticks ≈ 9 minutes).
const MAX_BLOCKS_PER_TICK = 1200;

// ── 改进 I2/I5/I7 的常量 ──

/** V2 adapter (KNOWN_ADAPTERS 注释里的第 5 个):官方 context 只写 storage、
 * 不发 AncillaryDataUpdated —— 事件驱动的盲区(回测 96 信号中 5 个,5.2%)。
 * QuestionReset 在 V2 上照常发,所以用它把 qid 收进轮询名单。 */
const V2_ADAPTER = "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74";
const V2_WATCH_TTL_MS = 14 * 24 * 3600_000;
const V2_WATCH_MAX = 40;
const V2_POLLS_PER_TICK = 3;

/** 洪水限流(I2):最近 6h 即时发出的方向性条目数超过阈值(2026-06 世界杯月
 * 单日峰值 320 个信号),非肥尾条目转入汇总队列。 */
const FLOOD_WINDOW_MS = 6 * 3600_000;
const FLOOD_MAX = Number(process.env.CHAIN_WATCH_FLOOD_MAX) || 12;

/** 汇总队列(I2/I5)冲洗条件:攒满 40 条,或最老条目滞留超过 6h。 */
const DIGEST_MAX_AGE_MS = 6 * 3600_000;
const DIGEST_MAX_SIZE = 40;

/** 每 tick 最多做几个盘口核查(I1)—— 每个约 2-4 次代理往返(negRisk 再加
 * ≤2 次直连 ethCall)。2026-07-15 SOOP 批 9 个姊妹盘只注解上 6 个,唯一 YES
 * 腿(批量澄清里仅有的肥尾腿)排第 8 连查询都没轮上 → 提到 12。断网 tick
 * 不会因此把预算吃满:lookupMarket 首个 Gamma 网络错误即短路其余 Gamma 路由,
 * 且循环内每项之间有 llmBudgetLeftMs 早停守卫。 */
const EXEC_ANNOTATE_MAX = 12;

// ── bt5 标记点落地(P1/P2/P3, 2026-07-10)的常量 ──

/** P1 总开关:预告时点预埋 + 承诺窗口快轮询。 */
const PREARM_ENABLED = (process.env.CHAIN_WATCH_PREARM ?? "").trim().toLowerCase() !== "off";
/** 预埋名单上限。bt5 实测 15 个月 80 个市场,批量裁定日一次可预埋数十个姊妹市场。 */
const PREARM_MAX = 80;
/** 承诺时点前多早进入快轮询。官方偶有提前 1-2 分钟落文本。 */
const PREARM_EARLY_MS = 3 * 60_000;
/** 承诺时点后多久放弃等待。实测兑现中位 +31s、CI 分钟级;15min 足够生死判定,
 * 过期未落地即官方兑现"无澄清"承诺(本身也是信息,见 digest 面包屑)。 */
const PREARM_LATE_MS = 15 * 60_000;
/** 快轮询间隔。ethCall storage 读约 0.1-0.5s/qid,12s 对免费 RPC 无压力。 */
const PREARM_POLL_MS = 12_000;
/** 单轮最多轮询的在窗 qid 数(RPC 负载上限;超出的取承诺时点最近者)。 */
const PREARM_POLL_QIDS_MAX = 12;
/** 快轮询让位时点:run-cron 170s SIGTERM 前留出发信与落盘余量,余下窗口由
 * 下一个 cron tick 接力。 */
const PREARM_LOOP_END_MS = 145_000;
/** 在窗 tick 上常规闸门 LLM 串行判读的让位时点:不设此界,批量姊妹市场日的
 * 闸门会按设计吃满预算(到 ~143s),快轮询恒零轮询 —— P1 在其设计针对的场景
 * (批量定时澄清)静默失效(审查确认)。100s 后闸门不再发起新 LLM 调用
 * (fail-open 照旧,正则方向邮件不受影响),给快轮询保底 ~45s。 */
const PREARM_GATE_LLM_CUTOFF_MS = 100_000;
/** 预埋时点相对 now 的上界。承诺时点只受文本自身约束时,敌手可用近-now 伪
 * 承诺批量挤占名单/让快轮询空转;真实惯例提前量中位 1.55h,48h 已宽裕。 */
const PREARM_MAX_LEAD_NOW_MS = 48 * 3600_000;
/** 单 tick 独立 ⏰ 邮件上限:批量姊妹市场同刻兑现(或敌手批量预埋)时,超出
 * 部分合并为一封批量邮件,不逐市场轰炸(审查确认:⏰ 无洪水闸,可被打成
 * 数十封/tick)。 */
const PREARM_FIRE_SOLO_MAX = 4;

/** run-cron.sh 的 timeout SIGTERM。 */
const TICK_KILL_MS = 170_000;
/** 为 sendMail+commitState 保留的尾部余量。 */
const SEND_MARGIN_MS = 12_000;
/** 剩余预算低于此值不再发起新 LLM 调用。 */
const LLM_MIN_CALL_MS = 15_000;

function rpcUrls(): string[] {
  const configured = process.env.ONCHAIN_RPC_URLS?.trim();
  if (configured) return configured.split(",").map((u) => u.trim()).filter(Boolean);
  // 2026-07-05 sufe 直连实测:publicnode 近头快但深窗口要 token;nodies/tenderly
  // 支持 600 块深回看(HEAD_WINDOW 的依托);1rpc 免费额度小,只作末位兜底。
  // drpc/polygon-rpc.com/llamarpc/blastapi/blockpi/ankr 均不可用或需 key。
  return [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-pokt.nodies.app",
    "https://gateway.tenderly.co/public/polygon",
    "https://1rpc.io/matic",
  ];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return rpcVia(rpcUrls(), method, params);
}

async function rpcVia<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      // AbortSignal.timeout covers the WHOLE request including the body read —
      // a plain controller+clearTimeout would fire clearTimeout right after the
      // headers arrive, leaving res.json() to hang up to undici's ~300s default
      // on a slow-drip RPC and stalling the whole tick past its cron slot.
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error || json.result === undefined) {
        throw new Error(json.error?.message ?? `empty ${method} result`);
      }
      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`all RPCs failed for ${method}`);
}

// ── State ──

/** An event whose regex stance was directionless and whose LLM second read
 * yielded NO verdict (CLI unavailable / timeout / budget-skipped). Its
 * fingerprint is already committed, so it will never re-enter byQid on its
 * own — this queue is the only path back to an LLM re-read (e.g. the first
 * hours after deploy, before CLAUDE_CODE_OAUTH_TOKEN lands in .env). */
interface LlmPendingEntry {
  adapter: string;
  kinds: string[];
  title: string | null;
  description: string | null;
  attempts: number;
  firstSeenAt: number;
  /** §5 补判缺口:入队时正则已有方向且已按 🟠 发信(LLM 无定论)。补判只为
   * 绿档升级 —— 升级成 🟢 才再次发信+自动执行,否则静默收队(🟠 已发过,
   * 重复无价值)。修复前这类事件永不补判,绿档机会永久丢失。 */
  mailedDirectional?: boolean;
}

/** §12(2026-07-19 审查):enrich 失败(RPC 瞬断/预算耗尽)的事件此前只降级
 * 发信一次,指纹随后提交、官方文本永不补读 —— 官方最终裁定往往是市场的最后
 * 一个事件,漏掉的恰是肥尾。与 llmPending 同构:入队限量重试,成功后构造
 * 完整 Notable 合入 byQid 重新过闸(指纹含 updateCount,补全后必然不同),
 * 超限放弃时进 digest 显式留痕。 */
interface PendingEnrichEntry {
  adapter: string;
  kinds: string[];
  attempts: number;
  firstSeenAt: number;
}

/** I7: a V2-adapter question being polled for storage-only context updates. */
interface V2WatchEntry {
  adapter: string;
  updateCount: number;
  firstSeenAt: number;
  lastPolledAt: number;
}

/** I2/I5: a directional event held back from immediate mail, awaiting the
 * periodic digest. The queue is the durable record — its fingerprint is
 * committed the moment it is queued, so a queued item never re-enters the
 * gate; losing the queue would lose the event, hence it lives in state. */
interface DigestEntry {
  qid: string;
  title: string | null;
  label: string;
  stance: string;
  llmStance: string | null;
  bestAsk: number | null;
  askUsd: number | null;
  marketUrl: string | null;
  /** Why it was digested: "flood" (I2 批量裁定限流)、"blue_no_edge" (I5 🔵收窄)
   * 或 "llm_gave_up" (M4 补判放弃兜底,不再静默丢弃)。 */
  reason: string;
  /** 自动下单结论摘要(如 "skipped"/"none $0"):路由已后移到执行之后,真金
   * 动手的条目会促升 immediate,这里是 skipped/none 结论的兜底留痕。 */
  trade?: string | null;
  at: number;
}

/** P1: a market whose official text promises a scheduled clarification time
 * ("if a clarification is to be issued, it will be at 1:00 PM ET on ...").
 * The entry is the durable contract — the heads-up mail is best-effort
 * (mailedAt marks success, absent = retry next tick), the in-window fast
 * poll is what actually converts the 1.55h lead into seconds-level reaction. */
interface PreArmEntry {
  adapter: string;
  title: string | null;
  /** 官方承诺的澄清时点(UTC epoch-ms)。 */
  commitAtMs: number;
  /** 模板原文摘录(邮件展示/人工核对)。 */
  quote: string;
  armedAtMs: number;
  /** 预埋时刻的官方 update 数;快轮询以 count 增长为"承诺兑现"判据。 */
  updateCountAtArm: number;
  /** 预埋通知邮件成功送出的时刻;缺失 = 下一 tick 重试。 */
  mailedAt?: number;
  /** 快轮询检出并成功发信后的 "updateCount:stance" 指纹 —— 常规扫描随后看到
   * 同一事件(kinds 可能多出 reset)时凭此去重,避免同一裁定双发。改期覆盖时
   * 必须携带(指纹键与时点无关);其 count > updateCountAtArm 表示"当前预埋代
   * 已兑现",count ≤ updateCountAtArm 表示携带自上一代(新窗口照常轮询)。 */
  firedFp?: string;
  /** 兑现发信时刻 —— fired 条目的保留期锚定它(而非 commitAtMs),停机追赶
   * 迟到的常规扫描事件仍能命中去重。 */
  firedAtMs?: number;
  /** 窗口外经常规扫描看到过新文本(承诺被提前兑现/中途插入其他文本)。 */
  sawUpdate?: boolean;
  /** §13(2026-07-19 审查):首轮盘口注解的 bestAsk 锚。重试轮(RPC/判读失败
   * 后重新检出)不得重锚 —— 落地后价格单调走高,重锚即追高,漂移带守卫被
   * 架空。null = 首轮注解时确实无盘口;undefined = 尚未注解过。 */
  anchorAsk?: number | null;
}

/** P1:该条目在"当前预埋代"(updateCountAtArm 所指的承诺)内是否已兑现发信。
 * firedFp 可能是改期覆盖携带的上一代指纹(count ≤ updateCountAtArm),那一代
 * 的兑现不应阻止新窗口的轮询与预警。 */
function firedCurrentGen(e: PreArmEntry): boolean {
  if (!e.firedFp) return false;
  return Number(e.firedFp.split(":")[0]) > e.updateCountAtArm;
}

interface WatchState {
  lastBlock: number;
  /** qid → fingerprint of the last notified condition (event kinds + update count + stance). */
  notified: Record<string, string>;
  /** qid → LLM re-read queue (see LlmPendingEntry). */
  llmPending: Record<string, LlmPendingEntry>;
  /** qid → enrich 失败重读队列(see PendingEnrichEntry,§12)。 */
  pendingEnrich: Record<string, PendingEnrichEntry>;
  /** qid → V2 storage-poll watchlist (see V2WatchEntry). */
  v2Watch: Record<string, V2WatchEntry>;
  /** qid → P1 预告时点预埋名单(see PreArmEntry). */
  preArm: Record<string, PreArmEntry>;
  /** Held-back directional events awaiting the digest mail. */
  digestQueue: DigestEntry[];
  /** Epoch-ms timestamps of immediately-mailed directional items (flood detector). */
  mailLog: number[];
  /** qid → QuestionReset 累计(P2 扩层组合红旗,2026-07-14 §7.3:多轮
   * dispute ∧ 方向性澄清 = Dota 形态)。lastBlock 单调去重防 crash 重扫
   * 重复计数;30 天 TTL 修剪。 */
  resetSeen: Record<string, { n: number; lastBlock: number; at: number }>;
  /** 顺手项(2026-07-19 审查):gap 告警发送失败的暂存 —— 原来失败只
   * console.error 一行,cursor 已提交,"永久漏扫"这个最需要人知道的事实
   * 随之永久静默。下 tick 重试,新 gap 合并累计。 */
  pendingGapAlert?: { gap: number; detail: string } | null;
}

function statePath(): string {
  const configured = process.env.CHAIN_WATCH_STATE?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(process.cwd(), "data", "chain-watch-state.json");
}

function loadState(): WatchState {
  let raw: string;
  try {
    raw = readFileSync(statePath(), "utf8");
  } catch {
    // first run — file absent
    return { lastBlock: 0, notified: {}, llmPending: {}, pendingEnrich: {}, v2Watch: {}, preArm: {}, digestQueue: [], mailLog: [], resetSeen: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastBlock: Number(parsed.lastBlock) || 0,
      notified: parsed.notified && typeof parsed.notified === "object" ? parsed.notified : {},
      llmPending:
        parsed.llmPending && typeof parsed.llmPending === "object" ? parsed.llmPending : {},
      pendingEnrich:
        parsed.pendingEnrich && typeof parsed.pendingEnrich === "object" ? parsed.pendingEnrich : {},
      v2Watch: parsed.v2Watch && typeof parsed.v2Watch === "object" ? parsed.v2Watch : {},
      preArm: parsed.preArm && typeof parsed.preArm === "object" ? parsed.preArm : {},
      digestQueue: Array.isArray(parsed.digestQueue) ? parsed.digestQueue : [],
      mailLog: Array.isArray(parsed.mailLog) ? parsed.mailLog.filter((t: unknown) => Number.isFinite(t)) : [],
      resetSeen: parsed.resetSeen && typeof parsed.resetSeen === "object" ? parsed.resetSeen : {},
      pendingGapAlert:
        parsed.pendingGapAlert && typeof parsed.pendingGapAlert === "object"
          ? parsed.pendingGapAlert
          : null,
    };
  } catch (err) {
    // File exists but is corrupt (truncated by a crash mid-write). Do NOT
    // silently reset to block 0 — that would re-scan head-3600 and re-notify.
    // Loud-fail so the tick exits non-zero and the operator sees it.
    throw new Error(
      `chain-watch state file ${statePath()} is corrupt: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function saveState(state: WatchState): void {
  writeFileAtomic(statePath(), JSON.stringify(state, null, 1));
}

// ── On-chain question title ──

/** Extract the human question title + description (settlement rules) from the
 * adapter's ancillary data ("q: title: <...>, description: <...> res_data:").
 * Minimal scan-based decode: find the dynamic bytes field of getQuestion's
 * return that looks like ancillary data (layout differs per adapter version).
 * The description feeds the LLM second read — official clarifications often
 * only make sense against the market's own resolution rules. */
async function fetchQuestionMeta(
  adapter: string,
  qid: string,
  budgetMs?: number
): Promise<{ title: string | null; description: string | null }> {
  try {
    const result = await ethCall(adapter, `${GET_QUESTION_SELECTOR}${qid.slice(2)}`, budgetMs);
    if (!result || result === "0x") return { title: null, description: null };
    const hex = result.slice(2);
    const utf8 = Buffer.from(hex, "hex").toString("utf8");
    const t = utf8.match(/title:\s*([^\n]{4,300}?)(?:,\s*description:|res_data:|$)/);
    const d = utf8.match(/description:\s*([\s\S]{4,2500}?)(?:\s*market_id:|\s*res_data:|$)/);
    return { title: t ? t[1].trim() : null, description: d ? d[1].trim() : null };
  } catch {
    return { title: null, description: null };
  }
}

// ── Main ──

interface Notable {
  qid: string;
  adapter: string;
  kinds: Set<"reset" | "context">;
  title: string | null;
  /** Market settlement rules from ancillary data — context the LLM second
   * read needs (official clarifications often only decide the question when
   * read against the market's own resolution criteria). */
  description: string | null;
  stance: string;
  confidence: string;
  refundClause: boolean;
  excerpt: string | null;
  updateCount: number;
  /** Full chronological official-update sequence — kept so the LLM second
   * reader sees the whole conversation, not just the latest excerpt. */
  updates: OfficialUpdate[];
  /** True only when getOfficialUpdates SUCCEEDED for this item. updates=[]
   * with enriched=false means "text unread" (RPC failure / enrich-budget
   * skip), which the mail gate must treat differently from "no text exists". */
  enriched: boolean;
  /** Second-opinion verdict from headless Claude (via=llm口径, never merged
   * into the regex stance). Undefined = not consulted, null = consulted but
   * failed/unavailable. */
  llm?: LlmStanceVerdict | null;
  /** I1 executability annotation. Undefined = not attempted, null = attempted
   * but Gamma/CLOB unreachable or market unmapped (fail-open). */
  exec?: ExecCheck | null;
  /** M3 复判:🟢🔥 候选的第二票与首票极性不一致时存下第二票(降级依据)。
   * undefined = 未复判或复判同向。bt4 实测同 prompt 方向翻转率 5%/次。 */
  llmRevoteMismatch?: LlmStanceVerdict;
  /** M5:同一官方文本(群发到姊妹市场)在本 tick 内出现互相矛盾的
   * eventStatus — 提示 LLM 对同簇事件状态判读不自洽,人工核对时点。 */
  esConflict?: boolean;
  /** P2(bt5/E2):最新官方文本是 "previous clarification was made in error"
   * 型更正 —— 15 个月全部 6 例真方向翻转的统一形态,市场此刻往往仍锚旧裁定
   * 价(错价窗口)。置顶展示并豁免洪水限流;独立通过双确认∧high 闸门的保留
   * 🟢(带 🔄 注解,照常 paper 登记),未过闸的走 🔄 展示专用(见 priorityOf)。 */
  correction?: boolean;
  /** P3(bt5/E3b):update 链含定时澄清预告模板 —— green∧该家族 n=13 均
   * −5.5% 且零肥尾(green∧非预告 +47% 含全部肥尾)。label-only 负向注解。 */
  forecastTemplate?: boolean;
  /** owner 白名单加固(2026-07-14):市场 creator 不在官方发布地址白名单内
   * —— getOfficialUpdates 读的是 creator 桶,creator 非官方意味着判读文本
   * 来源不可信(野市场/对抗注入)。置位后强制 stance none、跳过 LLM 与
   * 自动下单,邮件标红提示人工核对。 */
  untrustedCreator?: boolean;
  /** P2 扩层组合红旗(2026-07-14 §7.3):该 qid 的 QuestionReset 累计 ≥2
   * (多轮 dispute)。与方向性澄清并存 = Dota 形态(官方解释性裁决 vs 结算
   * 源数字矛盾 + 多轮 dispute,15 个月唯一无退款损失)。展示层红旗,不降档
   * 不拦执行 —— dispute 情境本身不降低官方预测力(92% vs 92.3%),事故
   * 基础率 1/15mo,降档会误杀 dispute 子集的正常好信号。 */
  multiDispute?: boolean;
  /** 自动下单结果(EXEC_MODE 控制;undefined = 未尝试)。闸门与 paper 登记
   * 同语义(🟢∧盘口存在),执行器内部另有价格/额度/去重/kill-switch 风控。 */
  trade?: TradeAttempt;
}

/** getOfficialUpdates + creator 白名单校验(2026-07-14 加固)。updates 按
 * (questionID, owner) 分桶,生产读的是 creator 桶;creator 非官方白名单
 * (野市场/对抗注入)时文本不可信 —— 一条 update 都不返回(判读/LLM/交易
 * 零暴露),untrusted 置位供通知标红。四处读取共用同一语义。 */
async function getTrustedOfficialUpdates(input: {
  resolvedBy: string;
  questionID: string;
  budgetMs?: number;
}): Promise<{ updates: OfficialUpdate[]; untrusted: boolean }> {
  const { updates, creator } = await getOfficialUpdates(input);
  if (updates.length > 0 && !isOfficialContextOwner(creator)) {
    console.warn(
      `[chain-watch] ${input.questionID.slice(0, 10)} creator ${creator ?? "?"} 非官方白名单,丢弃 ${updates.length} 条 context`
    );
    return { updates: [], untrusted: true };
  }
  return { updates, untrusted: false };
}

/** 从 update 链提取正则立场:优先最新的方向性文本,否则用最新一条的分类。
 * (主扫描 enrich / V2 轮询 / P1 快轮询三处共用的同一语义。) */
function applyStanceFromUpdates(item: Notable): void {
  for (let i = item.updates.length - 1; i >= 0; i -= 1) {
    const classified = stanceFromText(item.updates[i].text);
    if (isDirectionalStance(classified.stance)) {
      item.stance = classified.stance;
      item.confidence = classified.confidence;
      item.excerpt = item.updates[i].text.slice(0, 400);
      return;
    }
  }
  if (item.updates.length > 0) {
    const latest = item.updates[item.updates.length - 1];
    const classified = stanceFromText(latest.text);
    item.stance = classified.stance;
    item.confidence = classified.confidence;
    item.excerpt = latest.text.slice(0, 400);
  }
}

/** P2/P3 文本标记:更正裁定看最后两条(更正通常是最新文本;停机追赶时
 * "更正+后续文本"可能同批到达,只看最新会整体丢标——审查确认);预告模板家族
 * 看全链(与 bt5/E3b 的市场级分类口径一致——裁定落地后预告文本仍在链上)。 */
function annotateTextMarkers(item: Notable): void {
  if (item.updates.length === 0) return;
  if (item.updates.slice(-2).some((u) => detectCorrection(u.text))) item.correction = true;
  if (item.updates.some((u) => matchesScheduledClarificationTemplate(u.text))) {
    item.forecastTemplate = true;
  }
}

async function main(): Promise<void> {
  const tickStartedAt = Date.now();
  // 顺手项(2026-07-19 审查):每 tick 打一行生效配置 —— num() 兜底吞掉的环境
  // 变量拼写错误/非法值此前完全不可见,排障只能靠猜。
  {
    const ec = execConfig();
    console.log(
      JSON.stringify({
        mode: "chain-watch-config",
        exec_mode: ec.mode,
        max_order_usd: ec.maxOrderUsd,
        daily_max_usd: ec.dailyMaxUsd,
        total_max_usd: ec.totalMaxUsd,
        price_band: [ec.minPrice, ec.maxPrice],
        slippage: ec.slippage,
        loss_halt_count: ec.lossHaltCount,
        forecast_live: ec.forecastLive || undefined,
        prearm: PREARM_ENABLED,
        flood_max: FLOOD_MAX,
        boundary_guard: (process.env.LLM_BOUNDARY_GUARD ?? "").trim().toLowerCase() !== "off",
      })
    );
  }
  const state = loadState();
  const rawHead = Number(await rpc<string>("eth_blockNumber", []));
  if (!Number.isFinite(rawHead) || rawHead <= 0) throw new Error(`bad head: ${rawHead}`);

  // 头块守卫(毒化游标/低头静默两向;逻辑抽到 lib/polymarket/headGuard.ts
  // 与 onchainEvents 共享,语义不变):跳超 MAX_HEAD_ADVANCE 时反序 RPC 交叉
  // 核验,一致才接受(真实长停机);头远低于游标即 loud-fail。
  await guardHeadJump({
    rawHead,
    lastCursor: state.lastBlock,
    crossCheckHead: async () =>
      Number(await rpcVia<string>([...rpcUrls()].reverse(), "eth_blockNumber", [])),
    tag: "chain-watch",
    maxAdvance: MAX_HEAD_ADVANCE,
  });

  const elapsed = () => Date.now() - tickStartedAt;
  // 硬预算:SIGTERM 前的真实剩余。快轮询的决策与单次调用的超时钳制用它。
  const wallBudgetLeftMs = () => TICK_KILL_MS - SEND_MARGIN_MS - elapsed();
  // P1 承诺窗口是否临近/进行中(空扫描早退、闸门让位、sweep/enrich 预算钳制
  // 三处共用的同一判据)。
  const prearmWindowSoon = () =>
    PREARM_ENABLED &&
    Object.values(state.preArm).some(
      (e) =>
        !firedCurrentGen(e) &&
        Date.now() + TICK_KILL_MS >= e.commitAtMs - PREARM_EARLY_MS &&
        Date.now() <= e.commitAtMs + PREARM_LATE_MS
    );

  // Only scan up to a confirmed depth to avoid reorg/replica-lag silent misses.
  const head = rawHead - CONFIRMATIONS;
  const idealFrom = state.lastBlock > 0 ? state.lastBlock + 1 : head - HEAD_WINDOW;
  const from = Math.max(idealFrom, head - HEAD_WINDOW);
  const gap = from > idealFrom ? from - idealFrom : 0;
  const emptyRange = from > head;
  if (emptyRange) {
    // 陈旧副本/无新块:常规扫描无事可做。但承诺窗口临近时不能提前退出 ——
    // 那会吞掉整个在窗 tick 的快轮询驻留(审查确认:滞后副本恰落在承诺时点
    // 附近时,P1 秒级覆盖被打成 3min 盲洞)。带空扫描范围继续走到尾部。
    if (!prearmWindowSoon()) {
      console.log(JSON.stringify({ mode: "chain-watch", head, skipped: "no new blocks" }));
      return;
    }
  }

  // Cap the sweep so a catch-up tick still finishes (and commits its cursor)
  // inside run-cron's tick timeout; the rest of the backlog carries over.
  const to = Math.min(head, from + MAX_BLOCKS_PER_TICK - 1);

  // Fetch in ≤48-block windows — the strictest free-tier getLogs cap seen
  // (1rpc allows 50; publicnode ~127 near the head). A window that fails on
  // every RPC stops the sweep, but progress up to it is kept: the swept
  // range is processed and persisted, the rest retried next tick — so one
  // bad page no longer voids the whole tick (that's how 12% of blocks got
  // permanently skipped in the first day of deployment).
  // Soft time budgets inside run-cron's 170s SIGTERM: block/page caps bound
  // the WORK but not the TIME (a black-holed endpoint burns 15s per URL per
  // page; enrichment burns up to 10s per URL per ethCall). If the tick is
  // killed before commitState, no progress persists and the same slow range
  // is retried forever. Budgets guarantee every tick reaches send+commit.
  const SWEEP_BUDGET_MS = 100_000;
  const ENRICH_BUDGET_MS = 140_000;
  // §9(2026-07-19 审查):承诺窗口临近的 tick 上,sweep/enrich 预算同样钳到
  // PREARM_GATE_LLM_CUTOFF_MS —— 原来只有 LLM 闸门让位,enrich 仍可吃到
  // 140s,快轮询"保底 ~45s"的承诺对最耗时的环节实际无强制。
  const budgetCapMs = () => (prearmWindowSoon() ? PREARM_GATE_LLM_CUTOFF_MS : Infinity);
  const sweepBudgetMs = () => Math.min(SWEEP_BUDGET_MS, budgetCapMs());
  const enrichBudgetMs = () => Math.min(ENRICH_BUDGET_MS, budgetCapMs());

  const logs: Array<{ address: string; topics: string[]; blockNumber?: string }> = [];
  const WINDOW = 48;
  let sweptTo = from - 1;
  let sweepError: string | null = null;
  for (let start = from; start <= to; start += WINDOW) {
    if (elapsed() > sweepBudgetMs()) {
      sweepError = `sweep stopped at time budget (${Math.round(sweepBudgetMs() / 1000)}s); resuming next tick`;
      break;
    }
    const end = Math.min(start + WINDOW - 1, to);
    try {
      const page = await rpc<Array<{ address: string; topics: string[]; blockNumber?: string }>>("eth_getLogs", [
        {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          address: KNOWN_ADAPTERS,
          topics: [[TOPIC_QUESTION_RESET, TOPIC_ANCILLARY_UPDATED]],
        },
      ]);
      logs.push(...page);
      sweptTo = end;
    } catch (err) {
      sweepError = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  if (sweptTo < from && !emptyRange) {
    // Zero progress — keep old state untouched and exit non-zero so the
    // heartbeat marker/ping is NOT refreshed for this tick.
    throw new Error(`sweep made no progress: ${sweepError}`);
  }

  // Group events by questionID
  const byQid = new Map<string, Notable>();
  let nonOfficialDropped = 0;
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    const qid = log.topics?.[1]?.toLowerCase();
    if (!qid) continue;
    const kind = topic0 === TOPIC_QUESTION_RESET ? "reset" : topic0 === TOPIC_ANCILLARY_UPDATED ? "context" : null;
    if (!kind) continue;
    // owner 白名单(2026-07-14 加固):AncillaryDataUpdated 任何地址都能发,
    // 已实测对抗案例(Peng 案 troll 掐官方澄清前 4 秒抢发反向文、bot 测试
    // 文本)。topics[2]=owner;非白名单事件不触发 enrich/通知(防噪音 tick
    // 与 enrich 预算消耗),仅计数留痕。QuestionReset 是 OO 流程事件、无
    // owner 伪造面,不过滤。
    if (kind === "context") {
      const owner = log.topics?.[2] ? `0x${log.topics[2].slice(-40)}` : null;
      if (!isOfficialContextOwner(owner)) {
        nonOfficialDropped += 1;
        continue;
      }
    }
    // P2 扩层(2026-07-14 §7.3):QuestionReset 跨 tick 累计,≥2 = 多轮
    // dispute(Dota 形态红旗的一半)。block 单调去重:crash 后同窗口重扫
    // 不重复计数(同 block 同 qid 双 reset 极罕见,漏计是保守方向)。
    if (kind === "reset") {
      const blockNum = Number(log.blockNumber ?? 0) || 0;
      const seen = state.resetSeen[qid];
      if (!seen || blockNum > seen.lastBlock) {
        state.resetSeen[qid] = { n: (seen?.n ?? 0) + 1, lastBlock: blockNum, at: Date.now() };
      }
    }
    if (!byQid.has(qid)) {
      byQid.set(qid, {
        qid,
        adapter: log.address.toLowerCase(),
        kinds: new Set(),
        title: null,
        description: null,
        stance: "none",
        confidence: "none",
        refundClause: false,
        excerpt: null,
        updateCount: 0,
        updates: [],
        enriched: false,
      });
    }
    byQid.get(qid)!.kinds.add(kind);
  }

  /** P2 扩层:多轮 dispute 红旗置位(mailable 统一跑一遍 + P1 快轮询条目
   * 单独调用;幂等)。 */
  const markMultiDispute = (n: Notable): void => {
    if ((state.resetSeen[n.qid]?.n ?? 0) >= 2) n.multiDispute = true;
  };

  // Enrich each with title + official context read straight from the chain.
  // Past the time budget the remaining items go out un-enriched (title=null,
  // stance none) — a degraded but timely alert beats a tick killed by timeout
  // with nothing sent and no progress committed.
  for (const item of byQid.values()) {
    // §5(2026-07-19 审查):进入每项前要求真实墙钟余量 > 45s(单项最坏耗时,
    // 预算钳制后 fetchQuestionMeta ≤15s + getUpdates ≤25s)。原来只在项间比对
    // 软预算,一个黑洞端点的单项(3 次 ethCall × 每 URL 10s 串行)最坏 ~120s,
    // 能把 tick 连同待发邮件和 commitState 一起顶过 170s SIGTERM。
    if (elapsed() > enrichBudgetMs() || wallBudgetLeftMs() < 45_000) {
      console.warn(
        `[chain-watch] enrichment stopped at time budget (elapsed ${Math.round(elapsed() / 1000)}s); remaining events notify without title/context`
      );
      break;
    }
    const meta = await fetchQuestionMeta(item.adapter, item.qid, Math.min(15_000, wallBudgetLeftMs()));
    item.title = meta.title;
    item.description = meta.description;
    try {
      const { updates, untrusted } = await getTrustedOfficialUpdates({
        resolvedBy: item.adapter,
        questionID: item.qid,
        budgetMs: Math.min(25_000, wallBudgetLeftMs()),
      });
      item.enriched = true;
      item.untrustedCreator = untrusted || undefined;
      item.updateCount = updates.length;
      item.updates = updates;
      item.refundClause = detectRefundClause(updates.map((u) => u.text));
      applyStanceFromUpdates(item);
      annotateTextMarkers(item);
    } catch {
      // context unreadable — still notify on the reset event itself
    }
  }

  // ── I7: V2 storage 轮询兜底 ──
  // V2 adapter 只写 storage 不发 AncillaryDataUpdated。凡在 V2 上见过事件的
  // qid 进入 v2Watch;每 tick 轮询最旧的几个,getUpdates 数量增加即视为一次
  // context 事件,合入 byQid 走同一套闸门与指纹去重。14 天 TTL,40 条上限。
  const nowMs = Date.now();
  for (const item of byQid.values()) {
    if (item.adapter !== V2_ADAPTER) continue;
    const prev = state.v2Watch[item.qid];
    state.v2Watch[item.qid] = {
      adapter: item.adapter,
      updateCount: Math.max(item.updateCount, prev?.updateCount ?? 0),
      firstSeenAt: prev?.firstSeenAt ?? nowMs,
      lastPolledAt: nowMs,
    };
  }
  for (const [qid, w] of Object.entries(state.v2Watch)) {
    if (nowMs - w.firstSeenAt > V2_WATCH_TTL_MS) delete state.v2Watch[qid];
  }
  // resetSeen 修剪:争议流程以天计,30 天无新 reset 即过期(防 state 无界膨胀)。
  for (const [qid, r] of Object.entries(state.resetSeen)) {
    if (nowMs - r.at > 30 * 24 * 3600_000) delete state.resetSeen[qid];
  }
  {
    const keys = Object.keys(state.v2Watch);
    if (keys.length > V2_WATCH_MAX) {
      for (const k of keys.slice(0, keys.length - V2_WATCH_MAX)) delete state.v2Watch[k];
    }
  }
  let v2Polled = 0;
  const v2ToPoll = Object.entries(state.v2Watch)
    .filter(([qid]) => !byQid.has(qid))
    .sort((a, b) => a[1].lastPolledAt - b[1].lastPolledAt)
    .slice(0, V2_POLLS_PER_TICK);
  for (const [qid, w] of v2ToPoll) {
    if (elapsed() > enrichBudgetMs() || wallBudgetLeftMs() < 45_000) break;
    w.lastPolledAt = Date.now();
    try {
      const { updates } = await getTrustedOfficialUpdates({
        resolvedBy: w.adapter,
        questionID: qid,
        budgetMs: Math.min(25_000, wallBudgetLeftMs()),
      });
      v2Polled += 1;
      if (updates.length <= w.updateCount) continue;
      w.updateCount = updates.length;
      const meta = await fetchQuestionMeta(w.adapter, qid, Math.min(15_000, wallBudgetLeftMs()));
      const item: Notable = {
        qid,
        adapter: w.adapter,
        kinds: new Set(["context"]),
        title: meta.title,
        description: meta.description,
        stance: "none",
        confidence: "none",
        refundClause: detectRefundClause(updates.map((u) => u.text)),
        excerpt: null,
        updateCount: updates.length,
        updates,
        enriched: true,
      };
      applyStanceFromUpdates(item);
      annotateTextMarkers(item);
      byQid.set(qid, item);
    } catch {
      // RPC 瞬断 — lastPolledAt 已推进,下轮轮询别的条目,此条稍后重试
    }
  }

  // ── §12:enrich 失败重读队列(2026-07-19 审查)──
  // 本 tick enrich 失败/预算跳过的事件入队(本 tick 照旧按降级处理);后续
  // tick 限量补读,成功即构造完整 Notable 合入 byQid 走同一套闸门与指纹去重。
  const PENDING_ENRICH_MAX = 50;
  const PENDING_ENRICH_PER_TICK = 3;
  const PENDING_ENRICH_MAX_ATTEMPTS = 16;
  for (const item of byQid.values()) {
    if (item.enriched) {
      delete state.pendingEnrich[item.qid];
      continue;
    }
    const prev = state.pendingEnrich[item.qid];
    state.pendingEnrich[item.qid] = {
      adapter: item.adapter,
      kinds: [...new Set([...(prev?.kinds ?? []), ...item.kinds])],
      attempts: prev?.attempts ?? 0,
      firstSeenAt: prev?.firstSeenAt ?? Date.now(),
    };
  }
  {
    const retries = Object.entries(state.pendingEnrich)
      .filter(([qid]) => !byQid.has(qid))
      .sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt)
      .slice(0, PENDING_ENRICH_PER_TICK);
    for (const [qid, p] of retries) {
      if (elapsed() > enrichBudgetMs() || wallBudgetLeftMs() < 45_000) break;
      p.attempts += 1;
      let ok = false;
      try {
        const { updates, untrusted } = await getTrustedOfficialUpdates({
          resolvedBy: p.adapter,
          questionID: qid,
          budgetMs: Math.min(25_000, wallBudgetLeftMs()),
        });
        const meta = await fetchQuestionMeta(p.adapter, qid, Math.min(15_000, wallBudgetLeftMs()));
        const item: Notable = {
          qid,
          adapter: p.adapter,
          kinds: new Set(
            p.kinds.filter((k): k is "reset" | "context" => k === "reset" || k === "context")
          ),
          title: meta.title,
          description: meta.description,
          stance: "none",
          confidence: "none",
          refundClause: detectRefundClause(updates.map((u) => u.text)),
          excerpt: null,
          updateCount: updates.length,
          updates,
          enriched: true,
          untrustedCreator: untrusted || undefined,
        };
        applyStanceFromUpdates(item);
        annotateTextMarkers(item);
        byQid.set(qid, item);
        delete state.pendingEnrich[qid];
        ok = true;
      } catch {
        // 仍不可达 — 留队,下轮再试
      }
      if (!ok && (p.attempts >= PENDING_ENRICH_MAX_ATTEMPTS || Date.now() - p.firstSeenAt > 48 * 3600_000)) {
        // 放弃 ≠ 静默丢弃(M4 同语义):曾降级发信的事件方向始终未知,留痕。
        console.warn(`[chain-watch] pendingEnrich ${qid} 放弃补读(attempts=${p.attempts})`);
        delete state.pendingEnrich[qid];
        state.digestQueue.push({
          qid,
          title: null,
          label: `⚪ 官方文本补读失败(${p.attempts >= PENDING_ENRICH_MAX_ATTEMPTS ? `${p.attempts} 次尝试` : "48h"}后放弃)— 该事件曾降级通知,方向始终未知,建议人工核对`,
          stance: "none",
          llmStance: null,
          bestAsk: null,
          askUsd: null,
          marketUrl: null,
          reason: "enrich_gave_up",
          at: Date.now(),
        });
      }
    }
    const keys = Object.keys(state.pendingEnrich);
    if (keys.length > PENDING_ENRICH_MAX) {
      for (const k of keys.slice(0, keys.length - PENDING_ENRICH_MAX)) delete state.pendingEnrich[k];
    }
  }

  // ── P1:预告澄清时点解析与预埋(bt5/C1)──
  // 模板承诺提前量中位 1.55h、兑现精度中位 +31s(79/80)。对本 tick 全部已
  // enrich 条目扫承诺文本 —— 含将被闸门静默的无方向条目:预告文本本身通常
  // 无方向,恰恰是被静默的那类。解析出未过期承诺 → 预埋;承诺被改期 → 覆盖。
  const maybeArm = (item: Notable): void => {
    if (!PREARM_ENABLED || !item.enriched || item.updates.length === 0) return;
    for (let i = item.updates.length - 1; i >= 0; i -= 1) {
      const u = item.updates[i];
      const parsed = parseScheduledClarification(u.text, u.timestamp * 1000);
      if (!parsed) continue;
      const prev = state.preArm[item.qid];
      // 同一承诺的记账先于过期判断:迟到兑现(承诺已出窗才被扫到)也要落
      // sawUpdate,否则清理逻辑会发"无澄清落地"的假面包屑(审查确认)。
      if (prev && prev.commitAtMs === parsed.commitAtMs) {
        // 快轮询已兑现的那条文本自己经常规扫描复现时(count == firedFp 的
        // count)不抬 updateCountAtArm:抬平会让 firedCurrentGen 变回 false,
        // 已死的窗口复活空转、📅 过时预警可能补发(核验发现的回归)。
        const firedCount = prev.firedFp != null ? Number(prev.firedFp.split(":")[0]) : -1;
        if (item.updateCount > prev.updateCountAtArm && item.updateCount !== firedCount) {
          // 承诺被提前兑现/中途插入其他文本 —— 该文本已走常规闸门,这里只
          // 抬高兑现判据并记录,防止快轮询把同一条再发一遍。
          prev.updateCountAtArm = item.updateCount;
          prev.sawUpdate = true;
        }
        if (prev.title == null && item.title != null) prev.title = item.title;
        return;
      }
      // 最新一条承诺为准(改期即覆盖);已出窗的旧承诺不再预埋。
      if (parsed.commitAtMs + PREARM_LATE_MS <= Date.now()) return;
      // 敌手防御(审查确认):承诺时点只受文本自身约束时,近-now 伪承诺可批量
      // 挤占名单并让快轮询空转。上界锚定 now;残余的蓄意挤占最坏使 P1 退化回
      // 3min cron 基线(= 当前生产行为),不影响主管道任何告警。
      if (parsed.commitAtMs > Date.now() + PREARM_MAX_LEAD_NOW_MS) return;
      state.preArm[item.qid] = {
        adapter: item.adapter,
        title: item.title,
        commitAtMs: parsed.commitAtMs,
        quote: parsed.quote,
        armedAtMs: Date.now(),
        updateCountAtArm: item.updateCount,
        // 承诺文本之后已有更新文本(停机追赶时承诺+裁定同批到达):裁定已走
        // 常规闸门,这里只为窗口内可能的再次文本守望;过期不误报"无澄清"。
        ...(i < item.updates.length - 1 || prev?.sawUpdate ? { sawUpdate: true } : {}),
        // 改期覆盖必须携带去重指纹(键=updateCount:stance,与时点无关):否则
        // 已 ⏰ 发过的裁定在常规扫描复见(kinds 多出 reset)时双发(审查 major)。
        ...(prev?.firedFp ? { firedFp: prev.firedFp } : {}),
        ...(prev?.firedAtMs ? { firedAtMs: prev.firedAtMs } : {}),
        // 📅 邮件史 6h 冷却内携带:防敌手以每 3min 改期 tx 维持无限重发(审查
        // major);真实改期(bt5 未观测到)的代价是新时点预警可能被冷却吞掉,
        // 快轮询窗口本身照常重定位。
        ...(prev?.mailedAt && Date.now() - prev.mailedAt < 6 * 3600_000 ? { mailedAt: prev.mailedAt } : {}),
      };
      return;
    }
  };
  if (PREARM_ENABLED) {
    for (const item of byQid.values()) maybeArm(item);
  }
  // Decide what's notification-worthy and not already notified. Fingerprints
  // are computed but NOT committed to state.notified yet — they're only
  // persisted after the email actually goes out (at-least-once), so an SMTP
  // hiccup can't silently swallow a real dispute event.
  const pendingFingerprints = new Map<string, string>();
  const notable = [...byQid.values()].filter((item) => {
    const fingerprint = `${[...item.kinds].sort().join("+")}:${item.updateCount}:${item.stance}`;
    if (state.notified[item.qid] === fingerprint) return false;
    // P1 快轮询去重:承诺窗口内已对该 update 状态(count+stance)发过 ⏰ 邮件;
    // 常规扫描随后看到的同一事件 kinds 可能多出 reset(模板常伴 orderbook
    // clear),指纹因此不同 —— 单看 kinds 差异不值得对同一裁定再发一封。
    // 仅当本 tick 确实带 context(同一文本事件,reset 只是伴生)才吞;纯 reset
    // (对新裁定的真实 dispute,updates 数未变)必须放行(审查 major:宁重发,
    // 不吞新争议)。
    if (
      item.kinds.has("context") &&
      state.preArm[item.qid]?.firedFp === `${item.updateCount}:${item.stance}`
    ) {
      pendingFingerprints.set(item.qid, fingerprint); // 指纹照常推进
      return false;
    }
    pendingFingerprints.set(item.qid, fingerprint);
    return true;
  });

  // 过期清理:出窗未兑现 = 官方兑现了"无澄清"承诺,进 digest 留痕(不即时打扰,
  // 但这是"官方不会再说话"的确定性信息,人工据此可撤销观察)。兑现过的静默删。
  // 面包屑按 tick 聚合成单条:批量预告日一次可过期数十条,逐条入队会触发
  // digestQueue 100 条截断、挤掉真正的方向性信号(审查 major)。
  // §13(2026-07-19 审查):本块必须在上方 notable 指纹过滤之后跑 —— 先删
  // firedFp 再过滤,停机追赶迟到的同一事件就失去去重依据被双发。
  {
    const expiredUnanswered: Array<{ qid: string; title: string | null }> = [];
    for (const [qid, e] of Object.entries(state.preArm)) {
      // 兑现过的条目保留期锚定 fire 时刻 +2h(§13:原 30min 短于 HEAD_WINDOW
      // ≈2h 的停机追赶深度,追赶扫描迟到的同一裁定恰好错过去重窗口)。
      const retainUntil = Math.max(
        e.commitAtMs + PREARM_LATE_MS,
        e.firedAtMs != null ? e.firedAtMs + 2 * 3600_000 : 0
      );
      if (retainUntil > Date.now()) continue;
      if (!e.firedFp && !e.sawUpdate) expiredUnanswered.push({ qid, title: e.title });
      delete state.preArm[qid];
    }
    if (expiredUnanswered.length > 0) {
      const titles = expiredUnanswered
        .slice(0, 3)
        .map((x) => x.title ?? x.qid.slice(0, 10))
        .join(" / ");
      state.digestQueue.push({
        qid: expiredUnanswered[0].qid,
        title: `${titles}${expiredUnanswered.length > 3 ? ` 等${expiredUnanswered.length}个` : ""}`,
        label: `📅 预告时点已过,无澄清落地 ×${expiredUnanswered.length}(官方承诺兑现:不再有澄清)`,
        stance: "none",
        llmStance: null,
        bestAsk: null,
        askUsd: null,
        marketUrl: null,
        reason: "prearm_expired",
        at: Date.now(),
      });
    }
  }
  // 名单封顶:批量预告日一次可涌入数十个姊妹市场,超限时保承诺时点最近者。
  {
    const entries = Object.entries(state.preArm);
    if (entries.length > PREARM_MAX) {
      entries.sort((a, b) => a[1].commitAtMs - b[1].commitAtMs);
      for (const [qid] of entries.slice(PREARM_MAX)) delete state.preArm[qid];
    }
  }

  // Commit progress + notified fingerprints, then bound the map. Called only
  // after any required email send has succeeded. delete-then-set moves a
  // refreshed qid to the END of the key order — a plain overwrite keeps its
  // old position, and the prune below would then evict the fingerprint we
  // just wrote (insertion-order prune must behave like least-recently-used).
  const commitState = () => {
    for (const [qid, fp] of pendingFingerprints) {
      delete state.notified[qid];
      state.notified[qid] = fp;
    }
    state.lastBlock = sweptTo;
    const keys = Object.keys(state.notified);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete state.notified[k];
    }
    saveState(state);
  };

  // ── 发信闸门(2026-07-08 收窄):只有"方向性"事件才配打扰邮箱 ──
  // 生产判卷(74 事件 4 天)证明 97.3% 的链上争议事件无官方方向且不可执行,
  // "任何新事件都发信"只产生噪音。收窄后:
  //   1. 正则判出方向(isDirectionalStance) → 直接放行(32/32 口径的快路径);
  //   2. 正则无方向但存在官方文本 → 交给 headless Claude 复核完整 update
  //      时间序(修 Kelce 型"定义式裁定"假阴性),LLM 判出方向才放行,结果标
  //      via=llm 与正则口径隔离;
  //   3. 官方文本读取失败/预算跳过(enriched=false) → 降级发信(旧行为):
  //      cursor 即将永久越过该块,而官方最终裁定往往是市场的最后一个事件,
  //      静默等于永久漏报;
  //   4. 链上确实无官方文本(纯 QuestionReset)与 LLM 亦判无方向的 → 只写
  //      日志不发信。
  // LLM 无定论(CLI 不可用/超时/预算耗尽) → 该事件按纯正则结果处理(fail-open
  // 到规则收窄,绝不回到全量发信,也绝不吞掉正则已判出的方向),同时进入持久
  // llmPending 队列,后续 tick LLM 恢复后补判(如部署初期 token 未配的窗口)。
  // 所有 notable 无论发信与否都照常 commitState:指纹含 updateCount+stance,
  // 官方后续再发文本时指纹必变,事件仍会回来重新过闸。
  // 软预算:常规闸门视角的剩余(wallBudgetLeftMs/prearmWindowSoon 已在 main
  // 顶部定义,enrich 预算钳制与此处共用)。承诺窗口临近/进行中的 tick 上,
  // 闸门(含补判队列/盘口注解/复判)在 PREARM_GATE_LLM_CUTOFF_MS 后不再发起
  // 新调用,为 P1 快轮询保底 ~45s(审查确认:无此界则批量姊妹市场日闸门按
  // 设计吃满预算,快轮询恒零轮询,P1 在其设计针对的场景静默失效)。fail-open
  // 语义照旧:被让位跳过的判读走 llmPending 补判,正则方向邮件不受影响。
  const llmBudgetLeftMs = () =>
    prearmWindowSoon()
      ? Math.min(PREARM_GATE_LLM_CUTOFF_MS - elapsed(), wallBudgetLeftMs())
      : wallBudgetLeftMs();
  // 单次调用的超时被钳到剩余预算内:一个 149s 才开始的 60s 调用会越过 170s
  // SIGTERM,把整个 tick(连同待发的正则方向邮件和 commitState)一起杀掉。
  // §9:承诺窗口 tick 上再钳到 PREARM_LOOP_END_MS − elapsed,单个慢判读不许
  // 吃进快轮询的保底窗(5s 下限防负值;调用点自身有 LLM_MIN_CALL_MS 闸)。
  const consultLlm = (
    item: {
      qid: string;
      title: string | null;
      description: string | null;
      updates: OfficialUpdate[];
      stance: string;
      confidence: string;
      updateCount: number;
    },
    // M3 复判用:不同 suffix = 不同缓存键 → 强制真实第二票而非缓存回放
    cacheKeySuffix = ""
  ): Promise<LlmStanceVerdict | null> =>
    classifyStanceWithLlm({
      title: item.title,
      description: item.description,
      updates: item.updates,
      regexStance: { stance: item.stance, confidence: item.confidence },
      cacheKey: `${item.qid}:${item.updateCount}${cacheKeySuffix}`,
      timeoutMs: Math.max(
        5_000,
        Math.min(
          60_000,
          wallBudgetLeftMs(),
          prearmWindowSoon() ? PREARM_LOOP_END_MS - elapsed() : Infinity
        )
      ),
    });

  // ── 标题分级(结构化 tier,§3.4)── 分级逻辑在 lib/polymarket/tiering.ts。
  // 闸门(自动下单/paper 登记/复判/路由)只看 tier/rank,label 仅供人读展示
  // —— label 文案 15 个月改过 5+ 次,emoji 前缀判档是必然被踩的地雷。
  const boundaryGuardOn = (process.env.LLM_BOUNDARY_GUARD ?? "").trim().toLowerCase() !== "off";
  const priorityOf = (n: Notable): TierVerdict => tierOf(n, { boundaryGuardOn });
  const isFatTail = (n: Notable): boolean => priorityOf(n).tier === "green_fire";
  const polarity = stancePolarity;

  const mailable: Notable[] = [];
  let llmSkipped = 0;

  // A. 上轮遗留的 LLM 补判队列:本轮真实进入闸门的 qid 交回闸门处理(若又
  //    失败会重新入队);其余在预算内逐个补判,有定论(无论方向与否)即出队。
  //    交接判据必须是 notable 而非 byQid(审查打回后修正):快轮询兑现过的
  //    事件在常规扫描复现时恰好被指纹/firedFp 去重吞掉 —— byQid 有、notable
  //    无,按旧判据删除即把 16 次/48h 的补判契约结构性切断(M4 回归形态)。
  const notableQids = new Set(notable.map((n) => n.qid));
  for (const [qid, p] of Object.entries(state.llmPending)) {
    if (notableQids.has(qid)) {
      delete state.llmPending[qid];
      continue;
    }
    if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) break;
    let updates: OfficialUpdate[] = [];
    try {
      ({ updates } = await getTrustedOfficialUpdates({ resolvedBy: p.adapter, questionID: qid }));
    } catch {
      // RPC 瞬断 — 留队,下轮再试(attempts 照常累积,防永久滞留)
    }
    if (updates.length > 0) {
      const revived: Notable = {
        qid,
        adapter: p.adapter,
        kinds: new Set(p.kinds.filter((k): k is "reset" | "context" => k === "reset" || k === "context")),
        title: p.title,
        description: p.description ?? null,
        stance: "none",
        confidence: "none",
        refundClause: detectRefundClause(updates.map((u) => u.text)),
        excerpt: updates[updates.length - 1].text.slice(0, 400),
        updateCount: updates.length,
        updates,
        enriched: true,
      };
      applyStanceFromUpdates(revived);
      annotateTextMarkers(revived);
      maybeArm(revived);
      if (isDirectionalStance(revived.stance) && !p.mailedDirectional) {
        // 补判期间官方追加了方向性文本(罕见,通常伴随新事件走正常闸门)
        delete state.llmPending[qid];
        mailable.push(revived);
        continue;
      }
      const verdict = await consultLlm(revived);
      if (verdict) {
        delete state.llmPending[qid];
        if (p.mailedDirectional) {
          // §5:该事件已按 🟠 发过信 —— 补判只为绿档升级。经完整分级(M1/M2/
          // M3 降档照常适用)升级成 🟢 才值得再次发信+自动执行;其余静默收队。
          revived.llm = verdict;
          if (isGreen(priorityOf(revived))) mailable.push(revived);
        } else if (isDirectionalStance(verdict.stance)) {
          revived.llm = verdict;
          mailable.push(revived);
        }
        continue;
      }
    }
    p.attempts += 1;
    if (p.attempts >= 16 || Date.now() - p.firstSeenAt > 48 * 3600_000) {
      console.warn(`[chain-watch] llmPending ${qid} 放弃补判(attempts=${p.attempts})`);
      delete state.llmPending[qid];
      // M4:放弃 ≠ 静默丢弃。bt4 案例 14c9:被 null 吞掉的恰是"事后官方明写
      // qualifies for Yes"的最高置信信号。进汇总队列(非即时,不重开噪音闸)。
      state.digestQueue.push({
        qid,
        title: p.title,
        label: p.mailedDirectional
          ? `🟠 补判放弃(${p.attempts >= 16 ? `${p.attempts} 次尝试` : "48h"}):该官方方向事件已发 🟠,绿档升级复核未能完成`
          : `⚪ LLM 判读失败(${p.attempts >= 16 ? `${p.attempts} 次尝试` : "48h"}后放弃),正则亦无方向 — 建议人工瞄一眼`,
        stance: "none",
        llmStance: null,
        bestAsk: null,
        askUsd: null,
        marketUrl: null,
        reason: "llm_gave_up",
        at: Date.now(),
      });
    }
  }

  // B. 本轮事件闸门。回测结论(96 信号 train/holdout):正则方向的无偏胜率仅
  // 63-70%(模板文本假方向是主要亏损源),LLM 复核同向(置信≥medium)的子集
  // 12/12 全胜且 holdout 19/19 正确拒判噪音——所以正则方向的事件也统一送
  // LLM 复核:不拦截发信(32/32 口径的哨兵语义保留,LLM 挂了照发),但复核
  // 结果决定标题分级(🟢双确认 / 🟠LLM拒判警示),让邮箱里直接可分诊。
  // LLM 侧独立放行的方向判读要求置信 ≥medium(low 是回测里唯一漏网亏损)。
  for (const item of notable) {
    const hasText = item.updates.length > 0;
    if (!item.enriched && !hasText) {
      mailable.push(item); // 规则 3:读取失败 → 降级发信
      continue;
    }
    if (hasText) {
      if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) {
        llmSkipped += 1;
      } else {
        item.llm = await consultLlm(item);
      }
    }
    const regexDirectional = isDirectionalStance(item.stance);
    const llmDirectional =
      item.llm != null && isDirectionalStance(item.llm.stance) && item.llm.confidence !== "low";
    // P2:更正裁定即使双双无方向也放行 —— "撤回旧裁定"这一事件本身就是错价
    // 窗口信号(bt5/E2:全部真翻转都是此形态),静默等于丢掉最肥的时刻。
    if (regexDirectional || llmDirectional || item.correction) {
      mailable.push(item);
      // §5 补判缺口:正则有方向但 LLM 无定论(预算耗尽/失败)时,本 tick 只能
      // 发 🟠 —— 而它可能本是 🟢(双确认∧high,自动执行档)。入队补判,后续
      // tick LLM 恢复后复核,升级成 🟢 才重发+执行(mailedDirectional 语义)。
      // 修复前这类事件指纹已提交、永不复核,绿档机会永久丢失。
      if (regexDirectional && hasText && item.llm == null) {
        state.llmPending[item.qid] = {
          adapter: item.adapter,
          kinds: [...item.kinds],
          title: item.title,
          description: item.description,
          attempts: 0,
          firstSeenAt: Date.now(),
          mailedDirectional: true,
        };
      }
      continue;
    }
    if (hasText && item.llm == null) {
      // 无定论(失败/预算跳过,区别于"LLM 判了但无方向") → 入补判队列
      state.llmPending[item.qid] = {
        adapter: item.adapter,
        kinds: [...item.kinds],
        title: item.title,
        description: item.description,
        attempts: 0,
        firstSeenAt: Date.now(),
      };
    }
  }
  // 队列封顶:CLI 长期不可用时不能无界增长(淘汰最老的)
  {
    const pendingKeys = Object.keys(state.llmPending);
    if (pendingKeys.length > 50) {
      for (const k of pendingKeys.slice(0, pendingKeys.length - 50)) delete state.llmPending[k];
    }
  }
  for (const n of mailable) markMultiDispute(n);
  const suppressedItems = notable.filter((n) => !mailable.includes(n));
  const suppressed = suppressedItems.length;
  const degraded = mailable.filter((n) => !n.enriched).length;
  if (suppressed > 0) {
    console.log(
      JSON.stringify({
        mode: "chain-watch-suppressed",
        items: suppressedItems.map((i) => ({
          qid: i.qid.slice(0, 12),
          title: i.title?.slice(0, 60) ?? null,
          stance: i.stance,
          llm:
            i.llm === undefined
              ? i.updates.length === 0
                ? "no_text"
                : "not_consulted"
              : i.llm === null
                ? "unavailable"
                : i.llm.stance,
        })),
      })
    );
  }

  // ── I1: 盘口可执行性注解 ──
  // 回测实锤:87% 的方向性通知在信号后 2h 内连 $100 真实成交都没有。发信前
  // 对前几项做 Gamma/CLOB 核查(经代理,fail-open),把"能不能买、什么价、多深"
  // 直接写进邮件,并供 I3/I5 的分级与路由使用。
  let execChecked = 0;
  // §2.3:mailable 原序是事件发现序 —— 忙 tick 时 🟢 候选排位靠后拿不到盘口
  // 注解,maybeExecuteTrade 因无 exec 静默不执行。先按档位排序再切片(此刻
  // exec 未注解,rank 用无盘口口径判定,足以把 🟢/🔄 排到前面)。
  // 同档内 YES 腿优先(2026-07-15 SOOP 批教训):negRisk 批量澄清一次打出 N
  // 个姊妹盘,N−1 个 NO 腿 ask 早已贴 1、肉全在唯一的 YES 腿上 —— 它按事件
  // 发现序恰好排最后就整批白给。无方向腿(注解循环里本来就 continue)沉底,
  // 不再空占注解名额。
  const effDirectionalStance = (n: Notable): string | null =>
    isDirectionalStance(n.stance)
      ? n.stance
      : n.llm && isDirectionalStance(n.llm.stance)
        ? n.llm.stance
        : null;
  const annotatePriority = (n: Notable): number => {
    const eff = effDirectionalStance(n);
    if (eff == null) return 2; // 无方向:不会被注解,沉底
    return stancePolarity(eff) === "+" ? 0 : 1;
  };
  const annotateOrder = [...mailable].sort(
    (a, b) => priorityOf(a).rank - priorityOf(b).rank || annotatePriority(a) - annotatePriority(b)
  );
  for (const item of annotateOrder.slice(0, EXEC_ANNOTATE_MAX)) {
    if (llmBudgetLeftMs() < 10_000) break;
    const effStance = effDirectionalStance(item);
    if (!effStance) continue;
    item.exec = await checkExecutability({ adapter: item.adapter, qid: item.qid, stance: effStance });
    execChecked += 1;
  }

  // 标题即分诊:最高优先级事件的 stance·置信度直接进主题行。分级/降档全部
  // 逻辑与依据见 lib/polymarket/tiering.ts(§3.4 结构化 tier 重构后,priorityOf
  // /isFatTail 闭包已提前到闸门 A 段之前定义,这里不再重复)。

  // ── bt5/E1:dispute 时点领先侧翻盘风险标注 ──
  // 事件时点买领先侧的事件级翻盘率:ask≥0.95 → 6.4%,0.90–0.95 → 9.3% ——
  // 是 30s 扫描口径(≈3%,repricing 后幸存者)的 2-3 倍。通知方向与领先侧一致
  // (= 按方向买入价 ≥0.90)且本 tick 带 reset 事件时如实标注;只标不降档。
  const disputeRiskNote = (n: Notable): string | null => {
    if (!n.kinds.has("reset")) return null;
    const ask = n.exec?.bestAsk ?? null;
    if (ask == null || ask < 0.9) return null;
    const eff = isDirectionalStance(n.stance)
      ? n.stance
      : n.llm && isDirectionalStance(n.llm.stance)
        ? n.llm.stance
        : null;
    if (!eff) return null;
    return `⚠ 事件级翻盘风险 ${ask >= 0.95 ? "6.4%" : "9.3%"}(dispute 时点领先侧同向,bt5/E1)`;
  };

  // ── 自动下单结果的呈现(主路径与 P1 快路径共用)──
  const tradeLineHtml = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    // subjectAlert 是「引擎状态」级信息,任何 status 下都不允许被吞(审计
    // 2026-07-11 §11:filled 短路曾吞掉 "ledger写失败已停机" —— 已成交但未
    // 入账+引擎已停,被渲染成一次普通成功)。error 分支自己已展示 reason,
    // 只补告警标签;其余分支补完整 alert+reason 行。
    const alertHtml = t.subjectAlert
      ? `<div style="margin-top:2px;font-size:13px"><b style="color:#dc2626">⚠ ${escapeHtml(t.subjectAlert)}${t.status !== "error" && t.reason ? `: ${escapeHtml(t.reason)}` : ""}</b></div>`
      : "";
    if (t.status === "filled" || t.status === "partial")
      return `<div style="margin-top:2px;font-size:13px"><b style="color:#16a34a">🤖 已自动买入 ${escapeHtml(n.exec?.outcome ?? "")} $${t.filledUsd?.toFixed(2)}${t.status === "partial" ? `(部分,请求 $${t.requestedUsd}` + ")" : ""} @ 均价 ${t.avgPrice?.toFixed(3)}</b><span style="font-size:12px;color:#888"> · orderId ${escapeHtml((t.orderId ?? "?").slice(0, 12))}… · ${((t.latencyMs ?? 0) / 1000).toFixed(1)}s</span></div>${alertHtml}`;
    if (t.status === "none")
      return `<div style="margin-top:2px;font-size:13px;color:#d97706">🤖 FAK 提交成功但未成交(限价 ${t.limitPrice} 内无对手盘),已自动撤单</div>${alertHtml}`;
    if (t.status === "dry")
      return `<div style="margin-top:2px;font-size:13px;color:#2563eb">🤖[演练] 将买入 ${escapeHtml(n.exec?.outcome ?? "")} $${t.requestedUsd} @≤${t.limitPrice}(EXEC_MODE=dry,未提交)</div>${alertHtml}`;
    if (t.status === "error")
      return `<div style="margin-top:2px;font-size:13px"><b style="color:#dc2626">🤖 自动下单失败: ${escapeHtml(t.reason ?? "未知错误")}</b></div>${alertHtml}`;
    // P0-1④:额度打满等风控状态不再只是灰色小字 —— 这是「引擎停机」级信息。
    if (t.subjectAlert)
      return `<div style="margin-top:2px;font-size:13px"><b style="color:#dc2626">🤖 ${escapeHtml(t.subjectAlert)},未下单: ${escapeHtml(t.reason ?? "")}</b></div>`;
    return `<div style="margin-top:2px;font-size:12px;color:#888">🤖 未下单: ${escapeHtml(t.reason ?? "")}</div>`;
  };
  const tradeSubjectBit = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    // 同上:subjectAlert 追加到任何 status 的主题位之后,不被 filled 短路吞掉。
    const alert = t.subjectAlert ? ` 🤖${t.subjectAlert}⚠` : "";
    if (t.status === "filled") return ` 🤖已买$${t.filledUsd?.toFixed(0)}${alert}`;
    if (t.status === "partial") return ` 🤖部分$${t.filledUsd?.toFixed(0)}${alert}`;
    if (t.status === "error") return ` 🤖下单失败⚠${alert}`;
    if (t.status === "none") return ` 🤖未成交${alert}`;
    if (t.status === "dry") return ` 🤖dry${alert}`;
    return alert; // P0-1④:skipped 里的额度告警升到主题级
  };
  const tradeTextBit = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    if (t.status === "filled" || t.status === "partial")
      return ` TRADE:${t.status} $${t.filledUsd} @${t.avgPrice}`;
    return ` TRADE:${t.status}${t.reason ? `(${t.reason.slice(0, 60)})` : ""}`;
  };

  // ── M3:🟢🔥 复判(独立第二票)──
  // bt4/A5 实测:同 prompt 两次判读方向层翻转率 5%;三票多数杀噪声型误判
  // (Mutilation)但救不了系统性误读。🟢🔥 月频 ~1.4 笔,二票成本可忽略。
  // 降档条件(审查修正):二票方向性且极性相反(复判反向),或二票不再方向性
  // (复判失方向——模型在新采样下主动收回方向,这是信息)。二票同极性一律保持,
  // 不看二票置信度:弱同意仍是同意,否则"弱同意"会比"复判失败(null,保持原判
  // 的 fail-open)"更糟,语义倒挂。
  for (const n of mailable) {
    if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) break;
    if (!n.llm || !isFatTail(n)) continue;
    const second = await consultLlm(n, ":v2");
    if (second == null) continue;
    const agrees =
      isDirectionalStance(second.stance) && polarity(second.stance) === polarity(n.llm.stance);
    if (!agrees) n.llmRevoteMismatch = second;
  }

  // ── M5:同簇 eventStatus 一致性 ──
  // 同一官方文本群发到姊妹市场(bt4 案例 61a1:同文本一个市场判 decided、
  // 另一个判 pending)。方向可以因市场问题不同而不同,但"事件是否已决"不该
  // 自相矛盾——检测到即标注,供人工核对时点(不自动改判)。
  {
    const esByText = new Map<string, Set<string>>();
    for (const n of mailable) {
      const es = n.llm?.eventStatus;
      if (!es || n.updates.length === 0) continue;
      const key = n.updates[n.updates.length - 1].text;
      if (!esByText.has(key)) esByText.set(key, new Set());
      esByText.get(key)!.add(es);
    }
    for (const n of mailable) {
      if (!n.llm?.eventStatus || n.updates.length === 0) continue;
      const set = esByText.get(n.updates[n.updates.length - 1].text);
      // 只有 decided 与 pending 同时出现才是真矛盾;unclear 与谁共存都不算
      // (unclear=文本没说,不构成对立判断,审查修正)。
      if (set && set.has("decided") && set.has("pending")) n.esConflict = true;
    }
  }

  // (I5/I2 即时 vs 汇总路由已后移到自动下单循环之后 —— 审计 2026-07-11 §9:
  // 路由必须看得见 n.trade,否则洪水日照常实弹下单的普通 🟢 会带着真金成交
  // 进 6h 汇总,且 DigestEntry 快照里没有任何下单痕迹。)

  // ── I6: 🟢 自动登记 paper_trades(前瞻虚拟持仓,再也不用事后重建回测)──
  // localDb 惰性加载:chain-watch 的承诺是"无 sqlite 也能跑",登记失败只记日志。
  // 登记门槛 = 🟢 标签(而非 rank 0):P2 更正裁定同为 rank 0 但未经四臂验证,
  // 只通知不进前瞻登记。P1 快轮询检出的 🟢 走同一 helper。
  let paperRegistered = 0;
  const maybeRegisterPaperTrade = (n: Notable): void => {
    if ((process.env.PAPER_TRADES_AUTO ?? "").trim().toLowerCase() === "off") return;
    const pr = priorityOf(n);
    // §3.4:闸门只看结构化 tier(isGreen),不解析 label 文案。
    if (!isGreen(pr)) return;
    const e = n.exec;
    if (!e || e.closed || !e.fill100) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require("../lib/localDb") as typeof import("../lib/localDb");
      if (db.listOpenPaperTrades().some((t) => t.tokenId === e.tokenId)) return;
      // §11(2026-07-19 审查):paper 行加记 dirMethod 与闸门/判读快照 ——
      // 8 月预告家族 go/no-go 按闸门口径分层判定,不用 paper 池裸均值。
      // 布尔判定与 tradeExecutor 执行侧同条件(boundary fail-closed 版)。
      const leansStance =
        /^leans_/i.test(n.llm?.stance ?? "") || /^leans_/i.test(n.stance);
      db.insertPaperTrade({
        conditionId: e.conditionId,
        tokenId: e.tokenId,
        marketQuestion: e.question,
        outcomeBought: e.outcome,
        marketUrl: e.marketUrl,
        endDate: e.endDate,
        usdAmount: e.fill100.usd,
        shares: e.fill100.shares,
        avgFillPrice: e.fill100.avgPrice,
        worstFillPrice: e.fill100.worstPrice,
        fills: e.fill100.fills,
        dirMethod: e.dirMethod,
        gateMeta: {
          tier: pr.tier,
          label: pr.label,
          stance: n.stance,
          confidence: n.confidence,
          llmStance: n.llm?.stance ?? null,
          llmConfidence: n.llm?.confidence ?? null,
          llmEventStatus: n.llm?.eventStatus ?? null,
          forecastTemplate: n.forecastTemplate === true,
          correction: n.correction === true,
          multiDispute: n.multiDispute === true,
          bestAskAtSignal: e.bestAsk,
          feesEnabled: e.feesEnabled,
          feeRate: e.feeRate,
          // 预告家族三闸门快照(闸3 owner 白名单在事件层已拦,能走到这里即通过)
          gateBoundaryPass: !((n.llm?.eventStatus ?? null) !== "decided" && leansStance),
          gateMinPricePass: !(e.bestAsk != null && e.bestAsk < 0.3),
          gateOwnerPass: n.untrustedCreator !== true,
        },
      });
      paperRegistered += 1;
    } catch (err) {
      console.warn(
        `[chain-watch] paper trade 登记失败(${n.qid.slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  for (const n of mailable) maybeRegisterPaperTrade(n);

  // ── 自动下单(2026-07-10):与 paper 登记同一闸门(🟢 标签 ∧ 盘口存在),
  // 风控(EXEC_MODE 三态/kill-switch/单笔/日/总额度/价格带/滑点/去重 ledger)
  // 全部在 executeSignal 内部。fail-open:执行器绝不 throw,任何失败都只是
  // 邮件里多一行结果注解,绝不阻塞告警。P2 更正裁定过闸的 🟢(带🔄注解)照常
  // 执行 —— 与 paper 登记口径保持一致;🔄 展示专用(未过闸)不执行。
  // P0-2④ 自动执行白名单:只有确定性方向映射可以自动下单。bucket-contains/
  // bucket-anti 是启发式(execCheck 自认硬错误集中地),只发邮件人工确认。
  const AUTO_EXEC_DIR_METHODS = new Set<ExecCheck["dirMethod"]>([
    "yes-side",
    "no-side",
    "outcome-exact",
  ]);
  // 07-21 Burnham 复盘:前置 skip 分支在 executeSignal 之前 return,既不写
  // ledger 也不打 chain-watch-trade 行,汇总 trade_attempts 计数便找不到任何
  // 对应明细,事后只能靠 notified 指纹反推。skip 也打同构 JSON 行;ledger
  // 语义保持"executeSignal 必写"不变。
  const logTradeSkip = (n: Notable, tokenId?: string): void => {
    console.log(
      JSON.stringify({
        mode: "chain-watch-trade",
        qid: n.qid.slice(0, 12),
        token: tokenId ? tokenId.slice(0, 12) : undefined,
        status: n.trade?.status,
        reason: n.trade?.reason,
      })
    );
  };
  // anchorAskOverride(§13,仅 P1 快路径传):跨轮传递的首轮盘口锚,取代
  // 本轮 exec.bestAsk 作为执行漂移带的基准。undefined = 用本轮注解。
  const maybeExecuteTrade = async (
    n: Notable,
    anchorAskOverride?: number | null
  ): Promise<void> => {
    if (executionMode() === "off" || n.trade !== undefined) return;
    const pr = priorityOf(n);
    // §3.4:闸门只看结构化 tier(isGreen),不解析 label 文案 —— 标签改文案
    // 曾是"自动下单静默停摆"的必踩地雷。
    if (!isGreen(pr)) return;
    const e = n.exec;
    if (!e || !e.tokenId) {
      // 审计 2026-07-11 §13:🟢 没拿到盘口注解(注解循环预算耗尽/排在
      // EXEC_ANNOTATE_MAX 之外)不是"已评估被风控拦下",而是"没评估上"。
      // 静默 return 会让这笔机会无痕迹丢失(指纹随后照常提交、永不复核),
      // 而肥尾恰恰集中在注解预算最紧的批量澄清 tick。落 trade 记录升主题级。
      n.trade = {
        mode: executionMode(),
        status: "skipped",
        reason: e
          ? "exec 注解无 tokenId,自动执行未评估 — 人工确认"
          : "无盘口注解(注解预算耗尽或超出 EXEC_ANNOTATE_MAX),自动执行未评估 — 人工确认",
        subjectAlert: "🟢未评估",
      };
      logTradeSkip(n, e?.tokenId);
      return;
    }
    if (e.closed) {
      // 策略假设标定(2026-08-01 复盘):07-20→08-01 实测 9 次 exec 尝试中
      // 6 次落在此分支(07-26 批 5 个 + 07-28 1 个)——"结算后补发澄清"是
      // 官方主流行为(Burnham 07-21 同款),不是个案。事件驱动路径的可交易
      // 密度显著低于 bt3 回测口径(回测信号相当比例在实盘时点已无盘口),
      // 年化预期与 8 月 go/no-go 评估按此折减,勿以回测信号数直推实盘笔数。
      n.trade = { mode: executionMode(), status: "skipped", reason: "市场已关闭,无可执行盘口" };
      logTradeSkip(n, e.tokenId);
      return;
    }
    if (!AUTO_EXEC_DIR_METHODS.has(e.dirMethod)) {
      n.trade = {
        mode: executionMode(),
        status: "skipped",
        reason: `方向映射 ${e.dirMethod} 是 bucket 启发式,不自动执行 — 请人工确认后手动下单`,
      };
      logTradeSkip(n, e.tokenId);
      return;
    }
    try {
      n.trade = await executeSignal({
        qid: n.qid,
        tokenId: e.tokenId,
        conditionId: e.conditionId,
        outcome: e.outcome,
        question: e.question,
        marketUrl: e.marketUrl,
        label: pr.label,
        stance: n.stance,
        llmStance: n.llm?.stance ?? null,
        llmConfidence: n.llm?.confidence ?? null,
        llmEventStatus: n.llm?.eventStatus ?? null,
        bestAskAtSignal: anchorAskOverride !== undefined ? anchorAskOverride : e.bestAsk,
        // 空盘留痕恒取本轮注解:锚为 null 时,本轮 book 空 = taker 现在就
        // 买不进(空盘口径);本轮有挂单 = 仅缺漂移基准(人工确认口径)。
        bookEmpty: e.bookEmpty,
        dirMethod: e.dirMethod,
        negRisk: e.negRisk,
        // taker 费注解透传(2026-07-19 审查 §2:execCheck 取到了却在此丢弃,
        // 实盘记账因此全程不含费)。
        feesEnabled: e.feesEnabled,
        feeRate: e.feeRate,
        forecastTemplate: n.forecastTemplate === true,
        correction: n.correction === true,
        budgetMs: wallBudgetLeftMs(),
      });
      console.log(
        JSON.stringify({
          mode: "chain-watch-trade",
          qid: n.qid.slice(0, 12),
          token: e.tokenId.slice(0, 12),
          status: n.trade.status,
          reason: n.trade.reason,
          usd: n.trade.filledUsd ?? n.trade.requestedUsd,
          avgPrice: n.trade.avgPrice,
          latencyMs: n.trade.latencyMs,
        })
      );
    } catch (err) {
      // executeSignal 自身兜底不 throw;这里是双保险
      console.warn(
        `[chain-watch] 自动下单异常(${n.qid.slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  for (const n of mailable) await maybeExecuteTrade(n);

  // ── I5 🔵收窄 + I2 洪水限流:即时邮件 vs 汇总队列 ──
  // 在自动下单之后路由(审计 2026-07-11 §9):真金动过手(成交/部分/错误/引擎级
  // 告警)的条目不允许进 6h 汇总 —— 花钱不可见比邮件洪水更贵。
  const routeNow = Date.now();
  state.mailLog = state.mailLog.filter((t) => routeNow - t < FLOOD_WINDOW_MS);
  const floodActive = state.mailLog.length >= FLOOD_MAX;
  const immediate: Notable[] = [];
  const digested: Array<{ n: Notable; reason: string }> = [];
  for (const n of mailable) {
    const pr = priorityOf(n);
    const tradeUrgent =
      n.trade != null &&
      (n.trade.status === "filled" ||
        n.trade.status === "partial" ||
        n.trade.status === "error" ||
        n.trade.subjectAlert != null);
    // I5:🔵(纯 LLM 判读)只有"争议中"或"盘口显示有肉且可执行"才配即时打扰。
    // 回测 🔵 档 95% 胜率却 -0.1%/笔(0.99 薄 carry),模板簇判向率 67% 全不可执行。
    if (pr.rank === 2 && !tradeUrgent) {
      const hasEdge =
        n.kinds.has("reset") ||
        (n.exec != null && n.exec.bestAsk != null && n.exec.bestAsk < 0.97 && n.exec.executable);
      if (!hasEdge) {
        digested.push({ n, reason: "blue_no_edge" });
        continue;
      }
    }
    // I2:批量裁定洪水(2026-06 单月 690 信号/单日峰 320)中,只有肥尾候选、
    // 更正裁定(P2:全部真翻转形态,且事故簇之夜恰恰触发洪水——2025-11-17 实例)
    // 与降级告警(enriched=false,安全兜底语义不能延迟)保持即时,其余进汇总。
    if (
      floodActive &&
      pr.rank <= 2 &&
      !tradeUrgent &&
      !isFatTail(n) &&
      !isFatTailShape(n) &&
      !n.correction &&
      n.enriched
    ) {
      digested.push({ n, reason: "flood" });
      continue;
    }
    immediate.push(n);
  }
  for (const { n, reason } of digested) {
    state.digestQueue.push({
      qid: n.qid,
      title: n.title,
      label: priorityOf(n).label,
      stance: n.stance,
      llmStance: n.llm?.stance ?? null,
      bestAsk: n.exec?.bestAsk ?? null,
      askUsd: n.exec?.askUsdNear ?? null,
      marketUrl: n.exec?.marketUrl ?? null,
      // 兜底留痕:促升规则应保证进汇总的条目没动过真金,但 skipped/none 的
      // 下单结论仍值得在汇总里可见。
      trade: n.trade ? `${n.trade.status}${n.trade.filledUsd ? ` $${n.trade.filledUsd}` : ""}` : null,
      reason,
      at: routeNow,
    });
  }
  if (state.digestQueue.length > 100) {
    // 截断分层(审查 major):信息性面包屑(prearm_expired)先让位,方向性事件
    // (flood/blue_no_edge/llm_gave_up)最后才丢 —— 否则批量预告过期会把真正
    // 的方向性信号从队列里静默挤掉(其指纹已提交,丢即永久)。
    let toDrop = state.digestQueue.length - 100;
    state.digestQueue = state.digestQueue.filter((d) => {
      if (toDrop > 0 && d.reason === "prearm_expired") {
        toDrop -= 1;
        return false;
      }
      return true;
    });
    if (toDrop > 0) state.digestQueue.splice(0, toDrop);
  }

  // ── 顺手项:gap 告警发送(带 state 暂存重试)──
  // 失败不再只留一行日志:暂存 state.pendingGapAlert,下 tick 重试;新 gap
  // 与未送出的旧 gap 合并累计。
  const flushGapAlert = async (): Promise<void> => {
    const pending = state.pendingGapAlert;
    if (!pending) return;
    try {
      await sendMail({
        subject: `[PredEdge 链上] ⚠️ 永久漏扫 ${pending.gap} 个块`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p style="color:#d97706">⚠️ chain-watch 停机追赶超出回看窗口(${HEAD_WINDOW} 块),块 ${escapeHtml(pending.detail)}(共 ${pending.gap} 个)未被扫描且不可回补。若此区间有争议事件,可能已漏报。</p><p style="font-size:12px;color:#888">建议核对 Polymarket 争议区,或考虑接入更深回看能力的付费 RPC。</p></div>`,
        text: `chain-watch 永久漏扫 ${pending.gap} 个块(${pending.detail});停机超出回看窗口 ${HEAD_WINDOW}。`,
      });
      state.pendingGapAlert = null;
      saveState(state);
    } catch (err) {
      console.error(
        `[chain-watch] gap alert send failed (gap=${pending.gap},已暂存下 tick 重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── I2: 汇总队列冲洗(攒满 DIGEST_MAX_SIZE 条,或最老条目滞留超 6h)──
  // 独立于即时邮件的 best-effort:失败保留队列下轮重试,绝不阻塞 cursor 推进。
  const flushDigest = async (): Promise<void> => {
    const q = state.digestQueue;
    if (q.length === 0) return;
    const oldest = Math.min(...q.map((d) => d.at));
    if (q.length < DIGEST_MAX_SIZE && Date.now() - oldest < DIGEST_MAX_AGE_MS) return;
    const items = q.slice(0, 60);
    const digestRows = items
      .map(
        (d) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px">
      ${escapeHtml(d.title ?? d.qid)}<br>
      <span style="font-size:12px;color:#888">${escapeHtml(d.label)} · ${
        d.bestAsk != null ? `价${d.bestAsk.toFixed(3)} · 深$${Math.round(d.askUsd ?? 0)}` : "盘口未核对"
      }${d.trade ? ` · 🤖${escapeHtml(d.trade)}` : ""} · ${new Date(d.at).toISOString().slice(5, 16)}Z${
        d.marketUrl ? ` · <a href="${d.marketUrl}">市场</a>` : ""
      }</span>
    </td></tr>`
      )
      .join("\n");
    try {
      await sendMail({
        subject: `[PredEdge链上] 📦 低优先级方向事件汇总 ${items.length} 项`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p>洪水限流(I2)/🔵收窄(I5)期间积累的方向性事件,汇总如下(未即时打扰):</p><table style="width:100%;border-collapse:collapse">${digestRows}</table></div>`,
        text: items.map((d) => `${d.title ?? d.qid} | ${d.label} | ask=${d.bestAsk ?? "?"} 深$${d.askUsd ?? "?"}${d.trade ? ` | 🤖${d.trade}` : ""}`).join("\n"),
      });
      state.digestQueue = q.slice(items.length);
      saveState(state);
    } catch (err) {
      console.error(
        `[chain-watch] digest 发送失败(队列保留,下轮重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── P1:预埋通知邮件 ──
  // 1.55h 中位预警是人工模式此前结构性吃不到肥尾的唯一解法:提前到场。
  // 邮件 best-effort(mailedAt 标记成功,失败下轮重试);预埋状态本身随
  // commitState 已持久化,快轮询不依赖邮件是否送达。
  const flushPreArmMail = async (): Promise<void> => {
    if (!PREARM_ENABLED) return;
    // 只预警未来时点:已到/已过的承诺没有"提前到场"价值(快轮询 ⏰ 会覆盖),
    // 且这恰好封掉"近过去伪承诺 → 过期删条目洗掉 6h 冷却 → 重发"的骚扰向量
    // (核验发现的残余绕道)。
    const pending = Object.entries(state.preArm)
      .filter(([, e]) => !e.mailedAt && !firedCurrentGen(e) && e.commitAtMs > Date.now())
      .sort((a, b) => a[1].commitAtMs - b[1].commitAtMs);
    if (pending.length === 0) return;
    try {
      // rows 构造也在 try 内:链上文本喂进任何编码/格式化都可能抛(审查确认过
      // 代理对切裂案例),这里失败只能降级重试,不能把整个 tick 崩掉。
      const fmtRel = (ms: number): string => {
        const mins = Math.round((ms - Date.now()) / 60_000);
        if (mins <= 0) return "已到时点,本 tick 即进入快轮询"; // 边窗预埋不渲染负时长
        return mins >= 90 ? `约 ${(mins / 60).toFixed(1)}h 后` : `约 ${mins}min 后`;
      };
      const rows = pending
        .map(([qid, e]) => {
          const searchUrl = e.title
            ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(e.title, 80))}`
            : "https://polymarket.com";
          return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">
          <b>${escapeHtml(e.title ?? qid)}</b><br>
          <span style="color:#2563eb">承诺时点 ${new Date(e.commitAtMs).toISOString().slice(0, 16).replace("T", " ")}Z(${fmtRel(e.commitAtMs)})</span><br>
          <span style="font-size:12px;color:#888">"${escapeHtml(e.quote)}"</span><br>
          <a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(qid.slice(0, 10))}…
        </td></tr>`;
        })
        .join("\n");
      await sendMail({
        subject: `[PredEdge链上] 📅 官方预告澄清时点 ×${pending.length} | 最近 ${new Date(pending[0][1].commitAtMs).toISOString().slice(5, 16).replace("T", " ")}Z`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px">
          <p>官方文本承诺了定时澄清(bt5/C1:该模板 79/80 在承诺时点 ±1 分钟内兑现,提前量中位 1.55h):</p>
          <table style="width:100%;border-collapse:collapse">${rows}</table>
          <p style="font-size:12px;color:#888">系统将在各承诺时点 −${PREARM_EARLY_MS / 60_000}min/+${PREARM_LATE_MS / 60_000}min 窗口内以 ${PREARM_POLL_MS / 1000}s 间隔快轮询,裁定落地即发 ⏰ 邮件;时点过后无文本 = 官方兑现"无澄清"(digest 留痕)。注意:预告模板家族肉在落地瞬间(2026-07-14 研究:簇级 meat 中位 9~17pp),自动执行走三闸门制(boundary/防雷/白名单),当前为 paper 验证期。</p>
        </div>`,
        text: pending
          .map(([qid, e]) => `${e.title ?? qid} | 承诺时点 ${new Date(e.commitAtMs).toISOString()} | "${e.quote.slice(0, 120)}"`)
          .join("\n"),
      });
      const now = Date.now();
      for (const [, e] of pending) e.mailedAt = now;
      saveState(state);
    } catch (err) {
      console.error(
        `[chain-watch] P1 预埋通知发送失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── P0-4:结算对账 + 连亏熔断 + 赢单赎回提醒 ──
  // 已实现盈亏此前是全系统唯一没有防线的维度:autoHalt 只认执行错误,连亏
  // 8 笔 -$800 不触发任何告警;赢单也从无"该去赎回了"的提示(利润永不落袋)。
  // 每 tick 预算内跑(无持仓且无待通知时零网络调用);发信成功才 mark
  // notified(at-least-once,失败下 tick 重试)。承诺窗口临近时让位快轮询。
  const reconcileTrades = async (): Promise<void> => {
    if (wallBudgetLeftMs() < 25_000 || prearmWindowSoon()) return;
    try {
      const rec = await reconcileSettlements(Math.min(20_000, wallBudgetLeftMs() - 15_000));
      if (!rec || (rec.events.length === 0 && !rec.lossHalted)) return;
      const fmt = (v: number | null): string => (v == null ? "?" : `$${v.toFixed(2)}`);
      const rows = rec.events
        .map(
          (e) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">
          ${e.won === true ? "🎉" : e.won === false ? "📉" : "❔"} <b>${escapeHtml(e.question ?? e.conditionId.slice(0, 12))}</b><br>
          <span style="font-size:12px;color:#555">买入 ${escapeHtml(e.outcome ?? "?")} · 成本 ${fmt(e.costUsd)} → 结算 ${fmt(e.payoutUsd)} · 盈亏 <b style="color:${(e.pnlUsd ?? 0) >= 0 ? "#16a34a" : "#dc2626"}">${e.pnlUsd == null ? "无法计算(人工核对 ledger)" : `${e.pnlUsd >= 0 ? "+" : ""}$${e.pnlUsd.toFixed(2)}`}</b></span>
          ${e.won === true ? `<div style="font-size:12px;color:#16a34a">✅ 赢单已结算 —— 记得到 Polymarket 网页端赎回 ${fmt(e.payoutUsd)}(利润不会自动落袋)。</div>` : ""}
        </td></tr>`
        )
        .join("\n");
      const totalPnl = rec.events.reduce((s, e) => s + (e.pnlUsd ?? 0), 0);
      const subject = rec.lossHalted
        ? `[PredEdge实盘] ⛔ 连亏熔断(连亏 ${rec.consecutiveLosses} 笔)— 已停止自动交易`
        : `[PredEdge实盘] ${totalPnl >= 0 ? "💰" : "📉"} 持仓结算 ×${rec.events.length}(${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)})`;
      await sendMail({
        subject,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px">
          ${rec.lossHalted ? `<p style="color:#dc2626"><b>⛔ 结算对账检出连亏 ${rec.consecutiveLosses} 笔,已自动创建 kill-switch(data/trading-halt)停止自动交易。</b>疑似系统性误判,请人工复盘 ledger 与判读后删除该文件恢复。</p>` : ""}
          ${rec.events.length > 0 ? `<p>持仓结算对账结果:</p><table style="width:100%;border-collapse:collapse">${rows}</table>` : ""}
          <p style="font-size:12px;color:#888">口径:按 Gamma 结算价(outcomePrices)对 trade-ledger 实际成交核算;连亏熔断阈值 EXEC_LOSS_HALT_COUNT(默认 3)。</p>
        </div>`,
        text: rec.events
          .map((e) => `${e.won ? "WIN" : "LOSS"} ${e.question ?? e.conditionId} | cost=${e.costUsd} payout=${e.payoutUsd} pnl=${e.pnlUsd}`)
          .join("\n") + (rec.lossHalted ? `\n⛔ 连亏 ${rec.consecutiveLosses} 笔已自动熔断` : ""),
      });
      markSettlementsNotified(rec.events.map((e) => e.conditionId));
    } catch (err) {
      console.warn(
        `[chain-watch] 结算对账失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── P1:承诺时点快轮询 ──
  // bt5/C1 实测兑现精度中位 +31s,3min cron 结构性吃不到;e6 全窗口重抓证明
  // 收益断崖在 2-5 分钟(秒级入场较 2min 每笔 +5.75~12.75pp)。窗口内本 tick
  // 不退出:以 PREARM_POLL_MS 间隔直读各预埋 qid 的官方 updates(ethCall
  // storage 读,V1/V2 一律有效,绕开 V2 不发事件的盲区),新文本落地即完整判读
  // (正则+LLM+盘口+复判)。前 PREARM_FIRE_SOLO_MAX 个兑现独立发信,其余合并
  // 单封批量邮件(⏰ 无洪水闸,批量姊妹市场日不逐市场轰炸——审查 major)。
  // PREARM_LOOP_END_MS 让位给下一 tick 接力。
  const runPreArmFastLoop = async (): Promise<void> => {
    if (!PREARM_ENABLED) return;
    // 批量待发:已检出并判读、等 loop 末合并成单封邮件的兑现条目。firedFp 在
    // 邮件成功后才置位(at-least-once);置位前用本地集合防同 tick 重复检出。
    const batchPending = new Map<string, { e: PreArmEntry; item: Notable; latencyS: number }>();
    const inWindow = () =>
      Object.entries(state.preArm)
        .filter(
          ([qid, e]) =>
            !firedCurrentGen(e) &&
            !batchPending.has(qid) &&
            Date.now() >= e.commitAtMs - PREARM_EARLY_MS &&
            Date.now() <= e.commitAtMs + PREARM_LATE_MS
        )
        .sort((a, b) => a[1].commitAtMs - b[1].commitAtMs)
        .slice(0, PREARM_POLL_QIDS_MAX);
    if (inWindow().length === 0) return;
    console.log(`[chain-watch] P1 快轮询进入承诺窗口(${inWindow().length} 个预埋市场)`);
    let polls = 0;
    let fired = 0;
    // M5 同簇 es 一致性的快路径增量版:同 tick 先后兑现的姊妹市场共享同一
    // 官方文本时,decided/pending 矛盾照常标注(审查 major:原先完全绕过 M5)。
    const esSeenFast = new Map<string, Set<string>>();
    const markFired = (qid: string, e: PreArmEntry, item: Notable, rank: number): void => {
      e.firedFp = `${item.updateCount}:${item.stance}`;
      e.firedAtMs = Date.now();
      if (rank <= 2) state.mailLog.push(Date.now());
      delete state.notified[qid];
      state.notified[qid] = `context:${item.updateCount}:${item.stance}`;
      maybeRegisterPaperTrade(item);
    };
    while (elapsed() < PREARM_LOOP_END_MS) {
      const targets = inWindow();
      if (targets.length === 0) break;
      for (const [qid, e] of targets) {
        if (elapsed() >= PREARM_LOOP_END_MS) break;
        try {
          const { updates } = await getTrustedOfficialUpdates({
            resolvedBy: e.adapter,
            questionID: qid,
            budgetMs: Math.min(15_000, wallBudgetLeftMs()),
          });
          polls += 1;
          if (updates.length <= e.updateCountAtArm) continue;
          // 承诺兑现:新官方文本落地。与主闸门同语义的完整判读。
          const meta = await fetchQuestionMeta(e.adapter, qid, Math.min(15_000, wallBudgetLeftMs()));
          const item: Notable = {
            qid,
            adapter: e.adapter,
            kinds: new Set(["context"]),
            title: e.title ?? meta.title,
            description: meta.description,
            stance: "none",
            confidence: "none",
            refundClause: detectRefundClause(updates.map((u) => u.text)),
            excerpt: null,
            updateCount: updates.length,
            updates,
            enriched: true,
          };
          applyStanceFromUpdates(item);
          annotateTextMarkers(item);
          markMultiDispute(item);
          if (wallBudgetLeftMs() >= LLM_MIN_CALL_MS) item.llm = await consultLlm(item);
          else llmSkipped += 1;
          // M4 语义(审查 major):判读无定论(CLI 失败/预算跳过)且正则无方向时
          // 必须入 llmPending 补判队列 —— firedFp 会拦住常规扫描对同一事件的
          // 复核,不入队 = 判读升级通道被结构性切断(bt4 null 吞单的回归形态)。
          // correction 不入队(与主闸门语义一致:更正无论方向都已放行发信);
          // 判读成功则清掉早前失败轮次写入的旧条目,防 A 段重复升级发信。
          if (item.llm != null) {
            delete state.llmPending[qid];
          } else if (isDirectionalStance(item.stance)) {
            // §5:正则有方向但 LLM 无定论 —— ⏰ 邮件照发(🟠 级),入队补判;
            // 后续 tick 升级成 🟢 才重发+自动执行(mailedDirectional 语义)。
            state.llmPending[qid] = {
              adapter: item.adapter,
              kinds: [...item.kinds],
              title: item.title,
              description: item.description,
              attempts: 0,
              firstSeenAt: Date.now(),
              mailedDirectional: true,
            };
          } else if (!item.correction) {
            state.llmPending[qid] = {
              adapter: item.adapter,
              kinds: [...item.kinds],
              title: item.title,
              description: item.description,
              attempts: 0,
              firstSeenAt: Date.now(),
            };
          }
          // 盘口先于复判(审查 major:肥尾判定依赖 exec.bestAsk,原顺序下恒
          // false,M3 复判在快路径曾是死代码)。
          const effStance = isDirectionalStance(item.stance)
            ? item.stance
            : item.llm && isDirectionalStance(item.llm.stance)
              ? item.llm.stance
              : null;
          if (effStance && wallBudgetLeftMs() > 10_000) {
            item.exec = await checkExecutability({ adapter: item.adapter, qid, stance: effStance });
          }
          // §13:首轮真实盘口价即锚定,跨轮传递 —— 重试轮重新注解的 bestAsk
          // 已被落地后的重定价推高,拿它当漂移带基准等于放行追高。
          if (e.anchorAsk == null && item.exec?.bestAsk != null) e.anchorAsk = item.exec.bestAsk;
          // M3 复判:🟢 且(深价位或盘口未知)= 肥尾候选形态,关键决策必须二票。
          if (item.llm && wallBudgetLeftMs() >= LLM_MIN_CALL_MS) {
            const prePr = priorityOf(item);
            if (isGreen(prePr) && (item.exec?.bestAsk == null || item.exec.bestAsk <= 0.9)) {
              const second = await consultLlm(item, ":v2");
              if (second != null) {
                const agrees =
                  isDirectionalStance(second.stance) &&
                  polarity(second.stance) === polarity(item.llm.stance);
                if (!agrees) item.llmRevoteMismatch = second;
              }
            }
          }
          // M5 增量交叉:先记账,后比对(姊妹市场共享同一官方文本)。
          if (item.llm?.eventStatus && item.updates.length > 0) {
            const key = item.updates[item.updates.length - 1].text;
            if (!esSeenFast.has(key)) esSeenFast.set(key, new Set());
            const set = esSeenFast.get(key)!;
            set.add(item.llm.eventStatus);
            if (set.has("decided") && set.has("pending")) item.esConflict = true;
          }
          // 自动下单:快路径是全系统延迟最敏感的时刻(断崖 2-5min),执行先于
          // 发信;batch 路径同样执行(邮件合并只是通知路由,不是执行路由)。
          await maybeExecuteTrade(item, e.anchorAsk ?? undefined);
          const latencyS = Math.round((Date.now() - e.commitAtMs) / 1000);
          const pr = priorityOf(item);
          // §13(2026-07-19 审查):留痕(firedFp/notified 指纹/paper 登记)紧随
          // 执行落地,与邮件成败解耦 —— 原顺序下邮件失败重试会整段重放:重新
          // 注解的 bestAsk 重锚追高 + paper/执行路径重复进入。邮件此后只是
          // 通知:失败落 digest 面包屑,不再靠重新检出重试。
          fired += 1;
          markFired(qid, e, item, pr.rank);
          maybeArm(item); // 兑现文本本身可能是新预告(改期):统一走 maybeArm 重定位窗口
          saveState(state);
          if (fired > PREARM_FIRE_SOLO_MAX) {
            batchPending.set(qid, { e, item, latencyS });
            continue;
          }
          const searchUrl = item.title
            ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(item.title, 80))}`
            : "https://polymarket.com";
          const execBit =
            item.exec?.bestAsk != null
              ? ` | 价${item.exec.bestAsk.toFixed(2)} 深$${Math.round(item.exec.askUsdNear)}${item.exec.executable ? "" : "⚠"}`
              : "";
          const llmLine = item.llm
            ? isDirectionalStance(item.llm.stance)
              ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(item.llm.stance)} (${escapeHtml(item.llm.confidence)}, via=llm)</b>${item.llm.eventStatus ? `<span style="font-size:12px;color:#888"> · 事件${item.llm.eventStatus === "decided" ? "已决" : item.llm.eventStatus === "pending" ? "未决⚠" : "状态不明"}</span>` : ""}${item.esConflict ? `<span style="font-size:12px;color:#d97706"> · 同簇es不一致⚠</span>` : ""}${item.llmRevoteMismatch ? `<div style="font-size:12px;color:#d97706">复判二票: ${escapeHtml(item.llmRevoteMismatch.stance)} — 已降档</div>` : ""}${item.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(item.llm.evidence)}"</div>` : ""}</div>`
              : `<div style="margin-top:2px;font-size:12px;color:#888">LLM 判读: ${escapeHtml(item.llm.stance)} (${escapeHtml(item.llm.confidence)})</div>`
            : "";
          const execLine =
            item.exec?.bestAsk != null
              ? `<div style="margin-top:2px;font-size:13px"><b style="color:${item.exec.executable ? "#16a34a" : "#d97706"}">盘口: 买 ${escapeHtml(item.exec.outcome)} @${item.exec.bestAsk.toFixed(3)} · 近档深度 $${Math.round(item.exec.askUsdNear)}</b>${item.exec.fill100 ? ` · $100 市价单均价 ${item.exec.fill100.avgPrice.toFixed(3)}` : ""}${item.exec.marketUrl ? ` · <a href="${item.exec.marketUrl}">直达市场</a>` : ""}</div>`
              : "";
          try {
            await sendMail({
              subject: `[PredEdge链上] ⏰预告兑现 ${pr.label}${execBit}${tradeSubjectBit(item)} | ${safeSlice(item.title ?? qid, 48)}`,
              html: `<div style="font-family:system-ui,sans-serif;max-width:640px">
              <p><b>预告澄清承诺兑现</b>:承诺时点 ${new Date(e.commitAtMs).toISOString().slice(0, 16).replace("T", " ")}Z → 快轮询检出 ${latencyS >= 0 ? "+" : ""}${latencyS}s(bt5:入场断崖在 2-5 分钟,此刻是窗口)。</p>
              <div style="font-weight:600">${escapeHtml(item.title ?? qid)}</div>
              <div style="margin-top:4px">${isDirectionalStance(item.stance) ? `<b style="color:#d97706">官方方向: ${escapeHtml(item.stance)} (${escapeHtml(item.confidence)})</b>` : `正则立场: ${escapeHtml(item.stance)} (${escapeHtml(item.confidence)})`}</div>
              ${item.correction ? `<div style="margin-top:2px;font-size:13px;color:#dc2626"><b>🔄 此文本更正/撤回此前裁定 —— 核对新旧方向后再动。</b></div>` : ""}
              ${item.multiDispute && (isDirectionalStance(item.stance) || (item.llm != null && isDirectionalStance(item.llm.stance))) ? `<div style="margin-top:2px;font-size:13px;color:#d97706"><b>🚩 多轮 dispute ∧ 方向性澄清(Dota 形态)—— 下单前人工核对结算源数字。</b></div>` : ""}
              ${llmLine}
              ${execLine}
              ${tradeLineHtml(item)}
              ${item.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${escapeHtml(item.excerpt)}"</div>` : ""}
              <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(qid.slice(0, 10))}…</div>
              <p style="font-size:12px;color:#888">盘口为发信时刻快照;预告模板家族自动执行走三闸门制(2026-07-14 研究,paper 验证期),执行结果见上方注解。</p>
            </div>`,
              text: `预告兑现 +${latencyS}s | ${item.title ?? qid} | ${pr.label} | stance=${item.stance}(${item.confidence})${item.llm && isDirectionalStance(item.llm.stance) ? ` llm=${item.llm.stance}(${item.llm.confidence})` : ""}${item.exec?.bestAsk != null ? ` ask=${item.exec.bestAsk.toFixed(3)}` : ""}${tradeTextBit(item)}`,
            });
          } catch (mailErr) {
            // §13:已留痕/已执行,邮件失败只损失通知 —— 落 digest 面包屑可见,
            // 不再靠重新检出整段重试(那正是重锚追高的来源)。
            console.warn(
              `[chain-watch] P1 ⏰ 邮件发送失败(已留痕/已执行,通知转 digest): ${mailErr instanceof Error ? mailErr.message : String(mailErr)}`
            );
            state.digestQueue.push({
              qid,
              title: item.title,
              label: `⏰ 预告兑现(+${latencyS}s)通知邮件失败 — ${pr.label}`,
              stance: item.stance,
              llmStance: item.llm?.stance ?? null,
              bestAsk: item.exec?.bestAsk ?? null,
              askUsd: item.exec?.askUsdNear ?? null,
              marketUrl: item.exec?.marketUrl ?? null,
              trade: item.trade ? `${item.trade.status}${item.trade.filledUsd ? ` $${item.trade.filledUsd}` : ""}` : null,
              reason: "prearm_mail_failed",
              at: Date.now(),
            });
            saveState(state);
          }
        } catch (err) {
          // RPC/判读/盘口注解瞬断(执行与留痕之前的失败):firedFp 未置位,
          // 下一轮重新检出即重试(at-least-once)。必须留日志:这是全系统
          // 最高价值的时刻,静默失败不可接受。
          console.warn(
            `[chain-watch] P1 快轮询 ${qid.slice(0, 10)} 处理失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (elapsed() + PREARM_POLL_MS >= PREARM_LOOP_END_MS) break;
      await new Promise((resolve) => setTimeout(resolve, PREARM_POLL_MS));
    }
    // 批量冲洗:第 PREARM_FIRE_SOLO_MAX+1 个起的兑现合并单封。§13:条目已在
    // 检出时留痕(firedFp/执行/paper 登记),这里只是通知 —— 失败落 digest
    // 面包屑,不再靠重新检出重试。
    if (batchPending.size > 0) {
      try {
        const rows = [...batchPending.entries()]
          .map(([qid, { item, latencyS }]) => {
            const pr = priorityOf(item);
            return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px">
              ${escapeHtml(item.title ?? qid)}<br>
              <span style="font-size:12px;color:#888">${escapeHtml(pr.label)} · +${latencyS}s · stance=${escapeHtml(item.stance)}(${escapeHtml(item.confidence)})${item.llm && isDirectionalStance(item.llm.stance) ? ` · llm=${escapeHtml(item.llm.stance)}` : ""}${item.exec?.bestAsk != null ? ` · 价${item.exec.bestAsk.toFixed(3)} 深$${Math.round(item.exec.askUsdNear)}` : ""}${item.exec?.marketUrl ? ` · <a href="${item.exec.marketUrl}">市场</a>` : ""}</span>
              ${tradeLineHtml(item)}
            </td></tr>`;
          })
          .join("\n");
        await sendMail({
          subject: `[PredEdge链上] ⏰预告批量兑现 ×${batchPending.size}(同刻姊妹市场合并)`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p>本 tick 兑现超过 ${PREARM_FIRE_SOLO_MAX} 个(批量定时澄清),余下合并如下:</p><table style="width:100%;border-collapse:collapse">${rows}</table><p style="font-size:12px;color:#888">盘口为检出时刻快照;预告模板家族自动执行走三闸门制(2026-07-14 研究,paper 验证期),执行结果见各行注解。</p></div>`,
          text: [...batchPending.entries()]
            .map(([qid, { item, latencyS }]) => `${item.title ?? qid} | ${priorityOf(item).label} | +${latencyS}s | stance=${item.stance}`)
            .join("\n"),
        });
      } catch (err) {
        console.warn(
          `[chain-watch] P1 批量兑现邮件发送失败(已留痕/已执行,通知转 digest): ${err instanceof Error ? err.message : String(err)}`
        );
        for (const [qid, { item, latencyS }] of batchPending) {
          state.digestQueue.push({
            qid,
            title: item.title,
            label: `⏰ 预告批量兑现(+${latencyS}s)通知邮件失败 — ${priorityOf(item).label}`,
            stance: item.stance,
            llmStance: item.llm?.stance ?? null,
            bestAsk: item.exec?.bestAsk ?? null,
            askUsd: item.exec?.askUsdNear ?? null,
            marketUrl: item.exec?.marketUrl ?? null,
            trade: item.trade ? `${item.trade.status}${item.trade.filledUsd ? ` $${item.trade.filledUsd}` : ""}` : null,
            reason: "prearm_mail_failed",
            at: Date.now(),
          });
        }
        saveState(state);
      }
    }
    console.log(
      JSON.stringify({
        mode: "chain-watch-prearm",
        polls,
        fired,
        batched: batchPending.size || undefined,
        armed: Object.keys(state.preArm).length,
      })
    );
  };

  const logSummary = (notified: number) => {
    console.log(
      JSON.stringify({
        mode: "chain-watch",
        from,
        to: sweptTo,
        events: logs.length,
        non_official_dropped: nonOfficialDropped || undefined,
        untrusted_creator: notable.filter((n) => n.untrustedCreator).length || undefined,
        notified,
        queued_digest: digested.length,
        digest_queue: state.digestQueue.length,
        flood: floodActive || undefined,
        suppressed,
        degraded,
        exec_checked: execChecked,
        paper_registered: paperRegistered || undefined,
        exec_mode: executionMode() !== "off" ? executionMode() : undefined,
        trade_attempts: mailable.filter((n) => n.trade).length || undefined,
        trade_filled:
          mailable.filter((n) => n.trade && (n.trade.status === "filled" || n.trade.status === "partial"))
            .length || undefined,
        v2_watch: Object.keys(state.v2Watch).length || undefined,
        v2_polled: v2Polled || undefined,
        pre_armed: Object.keys(state.preArm).length || undefined,
        llm_cli_calls: llmCliCallCount(),
        llm_skipped: llmSkipped,
        llm_backed: mailable.filter((n) => n.llm && isDirectionalStance(n.llm.stance)).length,
        llm_pending: Object.keys(state.llmPending).length,
        gap,
        sweep_error: sweepError ?? undefined,
      })
    );
  };

  if (immediate.length === 0) {
    // 无需即时邮件(可能全部进了汇总队列):本 tick 的 gap 先并入暂存(随
    // commitState 持久化),cursor+指纹+队列落盘后再 best-effort 发送。
    if (gap > 0) {
      const prev = state.pendingGapAlert;
      state.pendingGapAlert = prev
        ? { gap: prev.gap + gap, detail: `${prev.detail}; ${idealFrom}–${from - 1}` }
        : { gap, detail: `${idealFrom}–${from - 1}` };
    }
    commitState();
    await flushGapAlert();
    await flushDigest();
    await flushPreArmMail();
    await reconcileTrades();
    logSummary(0);
    await runPreArmFastLoop();
    return;
  }

  immediate.sort((a, b) => priorityOf(a).rank - priorityOf(b).rank);
  const top = immediate[0];
  const topTitle = safeSlice(top.title ?? top.qid, 48);
  // I1 主题行注解:价与深度直接可见,"深$"不足 $100 挂 ⚠(87% 的通知属于此类)。
  const topExecBit = top.exec
    ? top.exec.bestAsk != null
      ? ` | 价${top.exec.bestAsk.toFixed(2)} 深$${Math.round(top.exec.askUsdNear)}${top.exec.executable ? "" : "⚠"}`
      : " | 无盘口⚠"
    : "";
  const subject = `[PredEdge链上] ${priorityOf(top).label}${topExecBit}${tradeSubjectBit(top)} | ${topTitle}${immediate.length > 1 ? ` 等${immediate.length}个` : ""}`;

  const rows = immediate
    .map((n) => {
      const searchUrl = n.title
        ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(n.title, 80))}`
        : `https://polymarket.com`;
      const kindLabel = [...n.kinds]
        .map((k) => (k === "reset" ? "争议重置(QuestionReset)" : "官方context更新"))
        .join(" + ");
      const degradedTag = !n.enriched
        ? ` · <b style="color:#d97706">⚠️ 官方文本读取失败(降级通知,方向未知)</b>`
        : "";
      const stanceLine = isDirectionalStance(n.stance)
        ? `<b style="color:#d97706">官方方向: ${escapeHtml(n.stance)} (${escapeHtml(n.confidence)})</b>`
        : `正则立场: ${escapeHtml(n.stance)} (${escapeHtml(n.confidence)})`;
      // LLM 判读呈现:与正则并列,明确标 via=llm——这是判读增强,不是 32/32
      // 口径的官方文本信号,依据引用原文供人工核对。
      const llmLine = n.llm
        ? isDirectionalStance(n.llm.stance)
          ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)}, via=llm)</b>${n.llm.eventStatus ? `<span style="font-size:12px;color:#888"> · 事件${n.llm.eventStatus === "decided" ? "已决" : n.llm.eventStatus === "pending" ? "未决⚠" : "状态不明"}</span>` : ""}${n.esConflict ? `<span style="font-size:12px;color:#d97706"> · 同簇es不一致⚠(同一官方文本在姊妹市场判出相反事件状态,核对时点)</span>` : ""}${n.llmRevoteMismatch ? `<div style="font-size:12px;color:#d97706">复判二票: ${escapeHtml(n.llmRevoteMismatch.stance)} (${escapeHtml(n.llmRevoteMismatch.confidence)}) — ${isDirectionalStance(n.llmRevoteMismatch.stance) ? "与首票极性相反" : "二票收回方向"},已降档</div>` : ""}${n.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(n.llm.evidence)}"</div>` : ""}${n.llm.reasoning ? `<div style="font-size:12px;color:#888">${escapeHtml(n.llm.reasoning)}</div>` : ""}</div>`
          : `<div style="margin-top:2px;font-size:12px;color:#888">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)})</div>`
        : "";
      // I1 盘口行:能买什么、什么价、多深、直达链接;未核查/失败时如实说明。
      const execLine = n.exec
        ? n.exec.bestAsk != null
          ? `<div style="margin-top:2px;font-size:13px"><b style="color:${n.exec.executable ? "#16a34a" : "#d97706"}">盘口: 买 ${escapeHtml(n.exec.outcome)} @${n.exec.bestAsk.toFixed(3)}${n.exec.bestBid != null ? ` (bid ${n.exec.bestBid.toFixed(3)})` : ""} · 近档深度 $${Math.round(n.exec.askUsdNear)}${n.exec.executable ? "" : " (<$100 难成交)"}</b>${n.exec.fill100 ? ` · $100 市价单均价 ${n.exec.fill100.avgPrice.toFixed(3)}` : ""}${n.exec.marketUrl ? ` · <a href="${n.exec.marketUrl}">直达市场</a>` : ""}</div>`
          : `<div style="margin-top:2px;font-size:13px;color:#d97706">盘口: 空(当前无卖单)${n.exec.marketUrl ? ` · <a href="${n.exec.marketUrl}">直达市场</a>` : ""}</div>`
        : n.exec === null
          ? `<div style="margin-top:2px;font-size:12px;color:#888">盘口未核对(Gamma/CLOB 不可达或市场未匹配)</div>`
          : "";
      const riskNote = disputeRiskNote(n);
      const riskLine = riskNote
        ? `<div style="margin-top:2px;font-size:12px;color:#d97706">${escapeHtml(riskNote)}</div>`
        : "";
      const correctionLine = n.correction
        ? `<div style="margin-top:2px;font-size:13px;color:#dc2626"><b>🔄 此文本更正/撤回此前裁定 —— 市场可能仍按旧裁定定价(bt5/E2:历史全部真方向翻转均为此形态),核对新旧方向后再动。</b></div>`
        : "";
      const untrustedLine = n.untrustedCreator
        ? `<div style="margin-top:2px;font-size:13px;color:#dc2626"><b>🚫 市场 creator 非官方发布地址 —— context 文本不可信已丢弃(判读/下单已隔离),人工核对后再动。</b></div>`
        : "";
      const multiDisputeLine =
        n.multiDispute && (isDirectionalStance(n.stance) || (n.llm != null && isDirectionalStance(n.llm.stance)))
          ? `<div style="margin-top:2px;font-size:13px;color:#d97706"><b>🚩 多轮 dispute(QuestionReset≥2)∧ 方向性澄清 —— Dota 形态红旗:官方解释性裁决若与结算源数字矛盾,是 15 个月唯一无退款损失形态,下单前人工核对结算源数字。</b></div>`
          : "";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #333">
          <div style="font-weight:600">${escapeHtml(n.title ?? n.qid)}</div>
          <div style="font-size:12px;color:#888">${kindLabel} · updates=${n.updateCount}${n.refundClause ? " · ⚠️refund条款" : ""}${degradedTag}</div>
          <div style="margin-top:4px">${stanceLine}</div>
          ${untrustedLine}
          ${multiDisputeLine}
          ${correctionLine}
          ${llmLine}
          ${execLine}
          ${tradeLineHtml(n)}
          ${riskLine}
          ${n.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${escapeHtml(n.excerpt)}"</div>` : ""}
          <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(n.qid.slice(0, 10))}…</div>
        </td></tr>`;
    })
    .join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
    <p>链上监听在块 ${from}–${sweptTo} 发现方向性争议事件:</p>
    ${gap > 0 ? `<p style="color:#d97706">⚠️ 距上次运行跳过了 ${gap} 个块(停机追赶超出免费 RPC 回看窗口)。</p>` : ""}
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${digested.length > 0 ? `<p style="font-size:12px;color:#888">另有 ${digested.length} 个低优先级方向事件进入汇总队列(当前 ${state.digestQueue.length} 项待汇总)。</p>` : ""}
    ${suppressed > 0 ? `<p style="font-size:12px;color:#888">另有 ${suppressed} 个无方向争议事件已按收窄策略静默(仅记日志)。</p>` : ""}
    <p style="font-size:12px;color:#888">盘口注解为发信时刻快照,下单前请再核对;LLM 判读(via=llm)是文本解读增强,非官方文本口径(32/32)本身,请核对引用原文。</p>
  </div>`;

  const text = immediate
    .map((n) => {
      const llmBit = n.llm && isDirectionalStance(n.llm.stance) ? ` llm=${n.llm.stance}(${n.llm.confidence})` : "";
      const execBit = n.exec?.bestAsk != null ? ` ask=${n.exec.bestAsk.toFixed(3)} depth$${Math.round(n.exec.askUsdNear)}` : "";
      const riskBit = disputeRiskNote(n) ? ` ${disputeRiskNote(n)}` : "";
      return `${n.title ?? n.qid} | ${[...n.kinds].join("+")} | stance=${n.stance}(${n.confidence})${llmBit}${execBit}${n.correction ? " CORRECTION" : ""}${riskBit}${n.refundClause ? " REFUND" : ""}${tradeTextBit(n)}`;
    })
    .join("\n");

  // At-least-once: send FIRST. If this throws, we fall through to the top-level
  // catch → exit 1 → state is NOT committed → next tick re-scans the same range
  // (cursor unchanged) and retries. A duplicate email on a later success is the
  // accepted trade-off; a permanently-lost dispute alert is not.
  await sendMail({ subject, html, text });
  // 洪水检测计数:只统计成功即时发出的方向性条目(rank≤2)。
  for (const n of immediate) {
    if (priorityOf(n).rank <= 2) state.mailLog.push(routeNow);
  }
  commitState();
  // 本 tick 的 gap 已随主邮件送达;这里只补送此前失败暂存的 gap 告警。
  await flushGapAlert();
  await flushDigest();
  await flushPreArmMail();
  await reconcileTrades();
  logSummary(immediate.length);
  await runPreArmFastLoop();
}

main().catch((err) => {
  console.error(`[chain-watch] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
