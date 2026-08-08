/**
 * Oregon D4 盘的 UMA 结算侧守望器(2026-08-08 建;市场 finalize 后删掉 cron 行)。
 *
 * ── 它监控的不是行情,是**结算流程** ────────────────────────────
 * oregon-sniper 管的是"还能不能买"(USDM R1 闸 + 盘口),本脚本管的是
 * "钱什么时候能回来、路上有没有出岔子"。两者数据源完全不同:前者读 USDM +
 * CLOB,后者只读 Polygon 链上的 UMA adapter/OptimisticOracle。
 * 所以本脚本**不复核 R1** —— 那是 sniper 的职责,crontab 里它每 10 分钟一轮。
 * 重复做只会在 USDM 抖动时产生两封内容相同的告警。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 条款给的是 7 天 holding:qualifying release 发布于 2026-08-06 12:30Z(官方
 * PDF 抬头 "Released Thursday, Aug. 6, 2026",USDM 惯例每周四 08:30 ET),
 * 7 天后 = 2026-08-13 12:30Z 起 finalize。但**条款只规定了"可以",没规定
 * "谁来做"** —— UMA 的结算要有人主动 proposePrice,而这条盘的 proposer
 * reward 只有 $0.60(2026-08-08 实测:全站 300 个在场市场里,标准档是
 * $500/$5 占 67.3%、$25000/$10 占 17.0%、$50000/$20 占 15.7%,本盘的
 * $250/$0.60 不属于任何一档,是扫到的最低值)。叠加"判读需要 USDM 专门
 * 知识"(FIPS 数字码 / 棘轮条款 / categorical 口径),通用提案 bot 判不了它。
 * ⟹ "没人来提案"是一个**概率不低**的分支,必须被看见,而不是等到某天想起来。
 *
 * ── 三个必须分开的时刻(改常量前先读)────────────────────────────
 *   PUBLICATION   2026-08-06 12:30Z  qualifying release 发布
 *   FINALIZE_AT   2026-08-13 12:30Z  holding 期满 = **合规提案的最早时点**
 *   SELF_PROPOSE  2026-08-14 12:30Z  仍无人提案 ⟹ 该我们自己上
 * FINALIZE_AT 之前 `Yes` 对**任何人**都是错误答案(条款下正确值是 p4
 * Too Early;OO 的 eventBased=true 就是为拦这个设的),所以那之前本脚本
 * 一封信都不发 —— 提前提醒只会诱发一次必然被 dispute 的提案。
 * SELF_PROPOSE 比 FINALIZE_AT 多留一天,有两个理由:① 给专业提案人时间,
 * 他们做了这活我们就不必押 $250;② 条款写的是 "7 calendar days from its
 * publication date",没写具体时刻,08-13 当天存在解释歧义,多等一天把歧义
 * 一起绕开。
 *
 * ── 为什么"错误提案"这一态刻意不去重 ──────────────────────────
 * 其余终态(已结算/窗口已开)都用 sentinel 只发一封,否则 cron 每 15 分钟
 * 一封、一天 96 封,真事件会被埋掉。**唯独 proposed_wrong 每轮都发**:
 * 提案人若提了 No,我们只有一个 liveness(默认 2h)的窗口去 dispute,过期
 * 就是 −$437 且不可逆。此时"吵"的代价是几封重复邮件,"静"的代价是全部本金。
 * 这个不对称决定了它必须绕过去重。
 *
 * ── 三态纪律(与 oregon-sniper §4.1 同源)──────────────────────
 * `proposer == 0x0` 与"RPC 读不到"必须分开。前者是"确实没人提案",后者是
 * 探针失效 —— 把后者当成前者,会在 RPC 全挂的那天让我们以为"一切正常、
 * 还没人提案",而真实情况可能是有人已经提了 No 且 liveness 正在流逝。
 * 读不到一律归 unreadable,单独按小时节流告警。
 *
 * 用法:
 *   ./run-cron.sh scripts/oregon-uma-watch.ts --once          # cron 模式
 *   ./run-cron.sh scripts/oregon-uma-watch.ts --once --no-mail # 干看
 *   ./run-cron.sh scripts/oregon-uma-watch.ts --once --simulate proposed_wrong
 *
 * 参数:
 *   --once            跑一轮退出(cron 模式;本脚本只有这一种模式)
 *   --no-mail         不发邮件,只打印判定
 *   --simulate <态>   自检:强制走某一态的告警路径,不读链
 *
 * cron(每 15 分钟;finalize 后连同 oregon-sniper 那行一起删):
 *   2,17,32,47 * * * * flock -n /tmp/prededge-oregon-uma.lock \
 *     $HOME/prededge/run-cron.sh scripts/oregon-uma-watch.ts --once \
 *     >> $HOME/prededge/logs/oregon-uma-watch.log 2>&1
 */
import fs from "node:fs";
import path from "node:path";
import { ethCall } from "../lib/polymarket/oracleState";

// ── 标的常量(与 oregon-sniper 同源,逐字一致)──────────────────
const QUESTION_ID = "0x07c68043825c3f4331acf8f7b6971abb7064aa8345b32a93260a7fb8270fed37";
/** UmaCtfAdapter。Gamma 的 resolvedBy 字段,2026-08-08 链上实测。 */
const ADAPTER = "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7";
const MARKET_URL =
  "https://polymarket.com/event/will-oregon-reach-d4-exceptional-drought-by-august-31-2026-20260721193813646";

// ── 时刻(见头部注释;测试可覆盖)────────────────────────────────
export const PUBLICATION_MS = Date.UTC(2026, 7, 6, 12, 30, 0);
export const FINALIZE_AT_MS = PUBLICATION_MS + 7 * 86_400_000;
export const SELF_PROPOSE_MS = FINALIZE_AT_MS + 86_400_000;

// ── UMA YES_OR_NO_QUERY 的取值(int256)──────────────────────────
const P_NO = 0n;
const P_YES = 10n ** 18n;
const P_UNKNOWN = 5n * 10n ** 17n;
/** type(int256).max —— "现在还不该定"。holding 期内的唯一正确答案。 */
const P_TOO_EARLY = 2n ** 255n - 1n;

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "oregon-uma-watch.jsonl");

const argv = process.argv.slice(2);
const NO_MAIL = argv.includes("--no-mail");
const SIMULATE = ((): string | null => {
  const i = argv.indexOf("--simulate");
  return i >= 0 ? (argv[i + 1] ?? null) : null;
})();

let outReady = false;
function emit(row: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  if (!outReady) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    outReady = true;
  }
  fs.appendFileSync(OUT, line + "\n");
  console.log(line);
}

// ══ 纯函数区(导出供 tests/oregonUmaWatch.test.ts 离线锁行为)══════

/** 一轮链上读数。null 表示读失败 —— 调用方必须把它与"字段为空"区分开。 */
export interface ChainRead {
  /** adapter.getQuestion().resolved */
  resolved: boolean;
  /** adapter.getQuestion().paused,或 manualResolutionTimestamp > 0 */
  paused: boolean;
  /** OO.getRequest().settled */
  settled: boolean;
  proposer: string;
  disputer: string;
  proposedPrice: bigint;
  resolvedPrice: bigint;
  /** liveness 到期的 unix 秒。提案出现后才非零。 */
  expirationTime: bigint;
}

export type UmaState =
  | "unreadable"
  | "waiting"
  | "window_open"
  | "overdue"
  | "proposed_yes"
  | "proposed_wrong"
  | "disputed"
  | "settled_yes"
  | "settled_other"
  | "paused";

export interface UmaVerdict {
  state: UmaState;
  /** 邮件严重度:info 正常推进 / warn 需留意 / crit 需要立刻动手 */
  severity: "info" | "warn" | "crit";
  /** 一句话结论,进邮件标题 */
  headline: string;
  /** 展开说明,进邮件正文 */
  detail: string;
  /**
   * 去重键。null = **本态不去重,每轮都发**(只有 proposed_wrong 用,理由见
   * 头部注释)。带 <日>/<小时> 后缀的键退化为"每天/每小时最多一封"。
   */
  dedupeKey: string | null;
  /** false = 完全不发信(仅 waiting;窗口未开时的沉默是刻意的) */
  notify: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (a: string): boolean => !a || a.toLowerCase() === ZERO;
const dayKey = (now: Date): string => now.toISOString().slice(0, 10);
const hourKey = (now: Date): string => now.toISOString().slice(0, 13).replace(/[-T]/g, "");

/** int256 价格 → 人类可读。未知取值原样回显十进制,不猜。 */
export function priceLabel(p: bigint): string {
  if (p === P_YES) return "Yes";
  if (p === P_NO) return "No";
  if (p === P_UNKNOWN) return "50/50(无法判定)";
  if (p === P_TOO_EARLY) return "Too Early(尚不该定)";
  return `未知取值 ${p.toString()}`;
}

/**
 * 演习邮件的醒目标记。
 *
 * 2026-08-08 实测教训:用 `--simulate proposed_yes` 验证 SMTP 链路时发出的
 * 那封信,主题与真事件**逐字相同**("✅ 已有人提案 Yes —— 我们无需动手"),
 * 收信人当场判成真事件并来问。假 proposer 地址(0xabc…0001)藏在正文里,
 * 而告警邮件的实际阅读方式是**只看标题**。
 * ⟹ 演习标记必须在**主题行**,不能只在正文。这是告警系统的通用教训:
 * 一封无法与真事件区分的演习邮件,比不发演习更糟 —— 它同时消耗信任和注意力。
 */
export const DRILL_BANNER =
  "⚠ 这是 --simulate 自检演习邮件,不是真实事件。链上未发生任何变化,无需采取任何行动。";

/** 主题行构造。抽成纯函数只为一件事:让"演习标记必须出现在主题里"可断言。 */
export function mailSubject(v: UmaVerdict, simulated: string | null): string {
  const tag = v.severity === "crit" ? "🚨 " : v.severity === "warn" ? "⚠️ " : "";
  const drill = simulated ? `【演习·非真实事件·${simulated}】` : "";
  return `${drill}${tag}Oregon D4 结算守望:${v.headline}`;
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** 剩余时长的人话表述。负数 = 已过期。 */
export function humanRemaining(ms: number): string {
  const past = ms < 0;
  const s = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const body = h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
  return past ? `已过期 ${body}` : `还剩 ${body}`;
}

/**
 * 全部判定集中在这里 —— 唯一的真值函数,链上读数 + 当前时刻 → 该不该发信、
 * 发什么。判定顺序不可调换:终态(已结算/暂停)优先于争议,争议优先于提案,
 * 提案优先于"无提案 + 时刻分支"。调换会让"已结算但曾被 dispute"报成争议中。
 */
export function umaVerdict(read: ChainRead | null, now: Date): UmaVerdict {
  const t = now.getTime();

  if (!read) {
    return {
      state: "unreadable",
      severity: "warn",
      headline: "UMA 链上状态读不到",
      detail:
        "Polygon RPC 全部端点均未返回可解析的 adapter/OptimisticOracle 状态。\n" +
        "⚠ 这**不等于**「没人提案」—— 探针失效期间可能已经出现提案(甚至是错误提案)。\n" +
        "请手工复核,或等下一轮自动重试。",
      dedupeKey: `unreadable-${hourKey(now)}`,
      notify: true,
    };
  }

  if (read.paused) {
    return {
      state: "paused",
      severity: "crit",
      headline: "adapter 被暂停 / 转人工裁定",
      detail:
        "adapter 的 question 处于 paused 或已标记 manual resolution。\n" +
        "这条路径绕开了 UMA 的常规流程,结果由 Polymarket 人工决定,需要立刻人工跟进。",
      dedupeKey: `paused-${dayKey(now)}`,
      notify: true,
    };
  }

  if (read.resolved || read.settled) {
    // 已结算优先读 resolvedPrice;它为 0 且 proposedPrice 非 0 时以后者为准
    // (settle 后 OO 的 resolvedPrice 才写入,两者存在一轮的时间差)。
    const finalPrice = read.resolvedPrice !== P_NO ? read.resolvedPrice : read.proposedPrice;
    const yes = finalPrice === P_YES;
    return {
      state: yes ? "settled_yes" : "settled_other",
      severity: yes ? "info" : "crit",
      headline: yes ? "✅ 市场已结算为 Yes —— 本单完成" : `🚨 市场结算为 ${priceLabel(finalPrice)}(非 Yes)`,
      detail: yes
        ? "UMA 已 settle,adapter 已 resolve,结果 = Yes。\n" +
          "437.516 股 YES 按 $1 赔付。Polymarket relayer 通常自动赎回,若数小时后仍未到账再手工 redeem。\n" +
          "⟹ 可以把 crontab 里 oregon-sniper 与 oregon-uma-watch 两行一并删掉了。"
        : `最终价格 = ${priceLabel(finalPrice)}。与我方持仓方向不符,持仓将归零。\n` +
          "结算已终局,链上无可撤销路径。请立刻人工复核发生了什么(条款争议?提案错误未被 dispute?)。",
      dedupeKey: `settled-${yes ? "yes" : "other"}`,
      notify: true,
    };
  }

  if (!isZero(read.disputer)) {
    return {
      state: "disputed",
      severity: "crit",
      headline: "⚠️ 提案被 dispute —— 已进入 DVM 投票",
      detail:
        `disputer = ${read.disputer}\n` +
        `被争议的提案值 = ${priceLabel(read.proposedPrice)}\n\n` +
        "争议进入 UMA DVM 投票,通常耗时 1–2 周,期间资金锁定。\n" +
        "若被争议的是 Yes(我方方向),需要准备好条款依据材料:USDM 官方 PDF\n" +
        "(droughtmonitor.unl.edu/data/pdf/20260804/20260804_OR_cat.pdf)抬头\n" +
        "写明 Released Thursday, Aug. 6, 2026,D4 = 2.15,条款阈值 1.00%,棘轮式。",
      dedupeKey: `disputed-${hourKey(now)}`,
      notify: true,
    };
  }

  if (!isZero(read.proposer)) {
    const yes = read.proposedPrice === P_YES;
    const expMs = Number(read.expirationTime) * 1000;
    const remain = expMs > 0 ? humanRemaining(expMs - t) : "(liveness 到期时刻未知)";
    if (yes) {
      return {
        state: "proposed_yes",
        severity: "info",
        headline: "✅ 已有人提案 Yes —— 我们无需动手",
        detail:
          `proposer = ${read.proposer}\n` +
          `提案值 = Yes\n` +
          `liveness 到期 = ${expMs > 0 ? fmtUtc(expMs) : "未知"}(${remain})\n\n` +
          "无人 dispute 则到期后自动 settle,YES 按 $1 赔付。\n" +
          "我们不需要押 $250,也不需要做任何事,等结算通知即可。",
        dedupeKey: "proposed-yes",
        notify: true,
      };
    }
    return {
      state: "proposed_wrong",
      severity: "crit",
      headline: `🚨🚨 有人提案 ${priceLabel(read.proposedPrice)} —— 必须在 liveness 内 dispute`,
      detail:
        `proposer = ${read.proposer}\n` +
        `提案值 = ${priceLabel(read.proposedPrice)} ← **与我方方向不符**\n` +
        `liveness 到期 = ${expMs > 0 ? fmtUtc(expMs) : "未知"}(${remain})\n\n` +
        "⚠ 过了这个时点提案自动生效,437.516 股 YES 归零,且链上不可撤销。\n\n" +
        "依据(dispute 时可直接引用):\n" +
        "· USDM 官方 PDF 20260804_OR_cat.pdf:D4 = 2.15,抬头 Released Thursday, Aug. 6, 2026\n" +
        "· 条款:「is 1.00% or greater in any weekly release published from market\n" +
        "  creation through August 31, 2026」—— 棘轮式,一期达标即锁定 Yes\n" +
        "· 08-06 发布落在 market creation(2026-07-24)与 08-31 之间\n\n" +
        `市场:${MARKET_URL}`,
      // 刻意不去重:liveness 只有 2h,漏一封 = 全部本金。见头部注释。
      dedupeKey: null,
      notify: true,
    };
  }

  // ── 无提案:按时刻分支 ──────────────────────────────────────
  if (t < FINALIZE_AT_MS) {
    return {
      state: "waiting",
      severity: "info",
      headline: "holding 期内,无提案(正常)",
      detail: `holding 期满于 ${fmtUtc(FINALIZE_AT_MS)}(${humanRemaining(FINALIZE_AT_MS - t)})。`,
      dedupeKey: null,
      notify: false, // 刻意静默:窗口未开时提醒只会诱发一次必然被 dispute 的提案
    };
  }

  if (t < SELF_PROPOSE_MS) {
    return {
      state: "window_open",
      severity: "info",
      headline: "📢 holding 期已满 —— 现在可以合规 propose 了",
      detail:
        `holding 期已于 ${fmtUtc(FINALIZE_AT_MS)} 期满,目前**仍无人提案**。\n\n` +
        "建议先等一等:专业提案人做这活赚 $0.60 reward,他们做了我们就不必押 $250。\n" +
        `若到 ${fmtUtc(SELF_PROPOSE_MS)} 仍无人提案,本脚本会再发一封提醒该自己动手。\n\n` +
        "自行提案的前置准备(现在可以先备好):\n" +
        "· 账户需有 ≥ $250 的 USDC.e(0x2791bca1f2de4661ed88a30c99a7a9449aa84174)\n" +
        "· bond 会在 liveness 走完后全额退回,外加 $0.60 reward",
      dedupeKey: "window-open",
      notify: true,
    };
  }

  return {
    state: "overdue",
    severity: "warn",
    headline: "📢 超过自提时点仍无人提案 —— 建议自己 propose",
    detail:
      `holding 期满于 ${fmtUtc(FINALIZE_AT_MS)},自提时点 ${fmtUtc(SELF_PROPOSE_MS)} 也已过,` +
      "链上 proposer 仍为空。\n\n" +
      "这正是本盘的已知风险:proposer reward 仅 $0.60(全站最低档,标准是 $5),\n" +
      "且判读需要 USDM 专门知识,通用提案 bot 判不了 ⟹ 可能没人会来做。\n\n" +
      "自行提案:押 $250 USDC.e,提 Yes,liveness(默认 2h)后取回 bond + $0.60。\n" +
      "赔率:冷门盘 dispute 实测基率 0/26(2026-08-08 抽样),且本盘条款是纯数字\n" +
      "vs 单一阈值型。此举目的是解锁 $437 的仓位,不是为赚那 $0.60。",
    dedupeKey: `overdue-${dayKey(now)}`, // 每天最多一封
    notify: true,
  };
}

// ══ 链上读取 ════════════════════════════════════════════════════

const w = (h: string, i: number): string => h.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (s: string): bigint => (s && s.length === 64 ? BigInt("0x" + s) : 0n);
const addrOf = (s: string): string => "0x" + (s || "").slice(24);

/** getQuestion 的返回里定位 ancillaryData:扫 offset 候选,取解出来以 "q:"
 * 开头的那段。硬编下标会在 adapter 版本间失效(各版本 struct 字段顺序不同),
 * 扫描则只依赖 ancillary data 自身的格式约定。 */
function findAncillary(raw: string): string | null {
  const total = (raw.length - 2) / 64;
  for (let i = 1; i < total; i++) {
    const off = Number(u(w(raw, i)));
    if (off < 64 || off > (total - 1) * 32) continue;
    const base = 32 + off;
    const len = Number(u(raw.slice(2 + base * 2, 2 + base * 2 + 64)));
    if (len < 100 || len > 6000) continue;
    const cand = raw.slice(2 + (base + 32) * 2, 2 + (base + 32) * 2 + len * 2);
    if (Buffer.from(cand, "hex").toString("utf8").startsWith("q:")) return cand;
  }
  return null;
}

async function readChain(): Promise<ChainRead | null> {
  try {
    const raw = await ethCall(ADAPTER, `0x58c039cd${QUESTION_ID.slice(2)}`);
    const requestTimestamp = u(w(raw, 1));
    if (requestTimestamp === 0n) return null; // request 未发起 = 读到的不是这条

    // QuestionData 的 resolved/paused 位置随 adapter 版本变动,用扫描避开:
    // 本 adapter 实测布局 t[4]=resolved t[5]=paused t[3]=emergencyResolutionTimestamp
    const resolved = u(w(raw, 5)) === 1n;
    const paused = u(w(raw, 6)) === 1n || u(w(raw, 4)) > 0n;

    const anc = findAncillary(raw);
    if (!anc) return null;

    const oo = addrOf(w(await ethCall(ADAPTER, "0x22302922"), 0));
    const id = Buffer.from("YES_OR_NO_QUERY").toString("hex").padEnd(64, "0");
    const call =
      "0xa9904f9b" +
      ADAPTER.slice(2).toLowerCase().padStart(64, "0") +
      id +
      requestTimestamp.toString(16).padStart(64, "0") +
      (128).toString(16).padStart(64, "0") +
      (anc.length / 2).toString(16).padStart(64, "0") +
      anc.padEnd(Math.ceil(anc.length / 64) * 64, "0");
    const r = await ethCall(oo, call);

    return {
      resolved,
      paused,
      settled: u(w(r, 3)) === 1n,
      proposer: addrOf(w(r, 0)),
      disputer: addrOf(w(r, 1)),
      proposedPrice: u(w(r, 11)),
      resolvedPrice: u(w(r, 12)),
      expirationTime: u(w(r, 13)),
    };
  } catch (err) {
    emit({ kind: "warn", msg: `链上读取失败: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

// ══ 发信 ════════════════════════════════════════════════════════

async function notify(v: UmaVerdict): Promise<void> {
  if (NO_MAIL) {
    emit({ kind: "mail-skipped", reason: "--no-mail", state: v.state });
    return;
  }
  // dedupeKey 为 null = 本态刻意不去重(proposed_wrong)
  if (v.dedupeKey) {
    const flag = path.join(ROOT, "data", `oregon-uma-notified-${v.dedupeKey}`);
    if (fs.existsSync(flag)) {
      emit({ kind: "mail-suppressed", state: v.state, key: v.dedupeKey });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      fs.writeFileSync(flag, `${new Date().toISOString()} ${v.headline}\n`);
    } catch (err) {
      // 写不进 sentinel 就照常发信(宁可多一封,不可漏告警)
      emit({ kind: "warn", msg: `sentinel 写入失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const subject = mailSubject(v, SIMULATE);
  const body = SIMULATE ? `${DRILL_BANNER}\n\n${v.detail}` : v.detail;
  const html =
    (SIMULATE ? `<p style="background:#fee;border:2px solid #c00;padding:10px;font-weight:bold">${DRILL_BANNER}</p>` : "") +
    `<h3>${v.headline}</h3>` +
    `<pre style="font:13px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap">${v.detail
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</pre>` +
    `<p><a href="${MARKET_URL}">打开市场</a> · 状态 <code>${v.state}</code> · ${new Date().toISOString()}</p>`;
  try {
    const { sendMail } = await import("./mailer");
    const info = await sendMail({ subject, html, text: `${v.headline}\n\n${body}` });
    emit({ kind: "mail", state: v.state, subject, messageId: info.messageId });
  } catch (err) {
    emit({ kind: "warn", msg: `发信失败: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ══ main ════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const now = new Date();

  if (SIMULATE) {
    const fake: Record<string, ChainRead | null> = {
      unreadable: null,
      proposed_yes: { resolved: false, paused: false, settled: false, proposer: "0xabc0000000000000000000000000000000000001", disputer: ZERO, proposedPrice: P_YES, resolvedPrice: 0n, expirationTime: BigInt(Math.floor(now.getTime() / 1000) + 7200) },
      proposed_wrong: { resolved: false, paused: false, settled: false, proposer: "0xabc0000000000000000000000000000000000002", disputer: ZERO, proposedPrice: P_NO, resolvedPrice: 0n, expirationTime: BigInt(Math.floor(now.getTime() / 1000) + 7200) },
      disputed: { resolved: false, paused: false, settled: false, proposer: "0xabc0000000000000000000000000000000000003", disputer: "0xdef0000000000000000000000000000000000004", proposedPrice: P_YES, resolvedPrice: 0n, expirationTime: 0n },
      settled_yes: { resolved: true, paused: false, settled: true, proposer: "0xabc0000000000000000000000000000000000005", disputer: ZERO, proposedPrice: P_YES, resolvedPrice: P_YES, expirationTime: 0n },
    };
    if (!(SIMULATE in fake)) {
      console.error(`未知 --simulate 值 ${SIMULATE};可用:${Object.keys(fake).join(" / ")}`);
      process.exit(2);
    }
    const v = umaVerdict(fake[SIMULATE]!, now);
    emit({ kind: "verdict", simulated: SIMULATE, state: v.state, severity: v.severity, headline: v.headline });
    if (v.notify) await notify(v);
    return;
  }

  const read = await readChain();
  const v = umaVerdict(read, now);
  emit({
    kind: "verdict",
    state: v.state,
    severity: v.severity,
    headline: v.headline,
    proposer: read?.proposer ?? null,
    disputer: read?.disputer ?? null,
    proposedPrice: read ? read.proposedPrice.toString() : null,
    expirationTime: read ? read.expirationTime.toString() : null,
  });
  if (v.notify) await notify(v);
}

// 直接执行时才跑 main;被 tests import 时不产生任何副作用。
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
