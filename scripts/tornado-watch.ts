/**
 * NCEI 龙卷风年度累计盘守望器(2026-08-08 建;盘 2027-01 结算后删掉 cron 行)。
 *
 * ── 它判什么 ────────────────────────────────────────────────────
 * 标的:`Will 1250 or more tornadoes occur in the United States in 2026?`
 * 判据是**累计量的算术下界**,不是条款棘轮 —— 这个区别决定了全部设计,先读 §1。
 *
 * ── §1 为什么这条盘不是 Oregon 那种"条款棘轮" ─────────────────
 * Oregon D4 盘的条款**明写**"任一期达标即永久锁定",所以 USDM 印出 2.15% 的那一刻
 * YES 在**条款上**就必然 $1。本盘条款完全没有这句话,相反它写的是:
 *
 *   "The market will resolve based on the first relevant tornado count published on the
 *    NCEI tornado time-series page **after this scheduled release time**〔= December 报告〕"
 *   "The market will **not** resolve based on any preliminary values published **before**
 *    the scheduled release time."
 *
 * ⟹ 结算读的是 **2027-01 上旬 December 报告发布后**的那一次 Jan–Dec 累计读数,
 * 中途任何一期(包括 8/10 的 July)都**不构成结算依据**。
 *
 * 那为什么现在就能判?因为**年度累计量在算术上单调不减**:Jan–Dec ≥ Jan–{已发布月}。
 * 于是可以给结果一个**下界**:
 *
 *     lowerBound = 最新 ytd 累计值 + 剩余月份贡献的历史最小值
 *
 * 若 `lowerBound ≥ 阈值`,那么除非 NCEI 把已印数字往下修,YES 已在算术上锁定。
 * **这仍然是 unlikely 不是 locked**(见 §2),但它是一个可量化、可监控的强判据。
 *
 * ── §2 为什么坚持标 unlikely 而不是 locked ───────────────────────
 * 三条各自独立、任一成立就不该叫 locked:
 * 1. `剩余月份贡献的历史最小值` 是**经验假设**,不是物理上界。理论上 8–12 月可以是 0
 *    (从 1950 年至今没发生过,但"没发生过"不等于"不可能")。Oregon 的 D4=2.15% 是
 *    **官方已印出的测量值**,性质不同。这正是 Virginia 干旱盘被判 unlikely 的同一条理由。
 * 2. **NCEI 会向下修订已印的月计数**(去重、跨县/跨海区重复报告合并)。条款虽写了
 *    "resolve independently of any subsequent revisions",但那保护的是**结算读数之后**的
 *    修订;结算读数**本身**就是修订后的累计值。
 * 3. 结算源可换:"If the NCEI website becomes permanently unavailable, this market will
 *    resolve using another credible source." ⟹ 派付不是纯机械读数。
 *
 * ── §3 三个已实测的坑(改代码前先读)──────────────────────────────
 * 1. **结算源是 NCEI,不是 SPC。** 条款写死 ncei.noaa.gov 那个 URL。SPC 只是上游,
 *    可作提前 1–2 天的先行指标,**不能当结算依据**。项目记忆里"SPC 需 filtered 口径"
 *    那条只适用于先行指标层。
 * 2. **NCEI 会瞬时限流**:2026-08-08 实测首读 200、随后 25s 与 60s 两次全超时
 *    (直连与生产出口皆然)、3 分钟后 3/3 恢复。**判死前必须重试**,否则会把
 *    "限流"误报成 unreadable,而 unreadable 会发告警 —— 每小时一封噪音。
 * 3. **值带 `*` 后缀**表示 preliminary(如 `"1141*"`),是**字符串不是数字**。
 *    直接 Number() 会得到 NaN。而按条款 preliminary **同样有效**,不必等 final
 *    (2026 的 final 要 2027-05 才存在,而盘 2027-01 就结算了 —— 只可能读到 preliminary)。
 *
 * ── §4 端点与页面结构 ───────────────────────────────────────────
 * 机读 JSON(不要抓 HTML —— 页面是 jQuery SPA,直接抓 /access/monitoring/tornadoes
 * 只会拿到约 10KB 空壳):
 *
 *   https://www.ncei.noaa.gov/access/monitoring/tornadoes/time-series/ytd/{N}/data.json
 *   N ∈ 1..12,`ytd/N` = 该年 January–{第 N 月} 的累计。键是 `YYYYMM`。
 *
 * "最新已发布月"靠**探测**确定,不靠推算:从 (当前月 − 1) 向下试,第一个含本年键的即是。
 * 这样每月发布日的时区/延迟差异都不必建模。
 *
 * ── §5 锚点校验:把"端点坏了"与"本月还没发布"分开 ────────────────
 * 这两件事的正确处置完全相反(前者告警、后者静默),而在 HTTP 层长得一样 ——
 * 都表现为"读不到 202607"。判别办法:同一响应里的**历史键**。
 * 历史键在(2025 及更早的 `YYYYMM`)⟹ 端点与解析都正常,只是本年该月未发布 ⟹ waiting。
 * 历史键也没了 ⟹ 端点/字段结构变了 ⟹ unreadable,告警。
 *
 * 用法:
 *   ./run-cron.sh scripts/tornado-watch.ts --once            # cron 模式
 *   ./run-cron.sh scripts/tornado-watch.ts --once --no-mail  # 干看
 *   ./run-cron.sh scripts/tornado-watch.ts --once --no-book  # 跳过盘口
 *   ./run-cron.sh scripts/tornado-watch.ts --once --simulate locked
 *
 * cron(每 30 分钟;发布日 2026-08-10 / 每月约 10 日 11:00 EDT 前后是关键窗口):
 *   7,37 * * * * flock -n /tmp/prededge-tornado.lock \
 *     $HOME/prededge/run-cron.sh scripts/tornado-watch.ts --once \
 *     >> $HOME/prededge/logs/tornado-watch.log 2>&1
 *
 * **本脚本只报告,绝不下单。** 下单需人工把 tokenId 钉进执行体(方向锁,见 §7)。
 */
import fs from "node:fs";
import path from "node:path";

// ── 标的常量(2026-08-08 从 Gamma 独立拉取核验)──────────────────
const SLUG = "will-1250-or-more-tornadoes-occur-in-the-united-states-in-2026";
const MARKET_ID = "1428393";
const CONDITION_ID = "0x8573d651a82cbec45f07062b45f3d57a53767d25f71cee58bc3b8cceba591d4d";
/**
 * YES 腿。**必须与 Gamma 的 `outcomes[0]==="Yes"` 逐字双向核对**(见 §7)。
 * 2026-08-08 实测:outcomes = ["Yes","No"],clobTokenIds[0] 即此值。
 */
const YES_TOKEN_ID =
  "3274128037323255693352700223516152318165926806162369715072005689501999219702";
const THRESHOLD = 1250;
/** 目标年份。跨年复用本脚本时改这里 + THRESHOLD + 三个盘面常量。 */
const YEAR = 2026;
/** feeSchedule.rate 实测值(feeType=weather_fees, feesEnabled=true)。 */
const FEE_RATE_FALLBACK = 0.05;
/** EV 计算的追高闸。扫描器口径比执行体宽一档:任务是"把肉报全"。 */
const MAX_PRICE = 0.97;
/**
 * 下界判据所用的历史窗口(年)。**这是判据的一部分,不是调参** —— 见 remainderStats 头注。
 * 取 20:短到能排除 1950–60 年代的量纲(那时全年 200–600 个、无多普勒雷达网),
 * 长到不会被单个异常年左右(20 年样本里 2012 的 210 是最小值)。
 */
const DECISION_WINDOW_YEARS = 20;
/** 一起报出来的对照窗口,让判据的窗口敏感性可见。 */
const SENSITIVITY_WINDOWS = [5, 10, 20, 40, 80];

const NCEI = "https://www.ncei.noaa.gov/access/monitoring/tornadoes/time-series";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const MARKET_URL = `https://polymarket.com/event/${SLUG}`;

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "tornado-watch.jsonl");

const argv = process.argv.slice(2);
const NO_MAIL = argv.includes("--no-mail");
const NO_BOOK = argv.includes("--no-book");
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

// ══ 纯函数区(导出供 tests/tornadoWatch.test.ts 离线锁行为)════════

/** NCEI `tornadoes` 对象:键 `YYYYMM`,值可能是 number 或带 `*` 的字符串。 */
export type NceiSeries = Record<string, unknown>;

/**
 * 解析一个 NCEI 值。
 *
 * `"1141*"` → 1141(`*` = preliminary,按条款**同样有效**)。
 * 非数 / null / 空串 → null。**绝不返回 0** —— 0 是合法计数,不能用来表示"读不到"。
 */
export function parseNceiValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\*+$/, "").replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 该值是否被标注为 preliminary(带 `*`)。仅用于展示与留档,不影响判定。 */
export function isPreliminary(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().endsWith("*");
}

export interface SeriesRead {
  /** 本年该 ytd 档的累计值。null = 本年该月尚未发布(或读不到)。 */
  currentValue: number | null;
  currentPreliminary: boolean;
  /** 同一响应里可解析的**历史**年份键数(不含本年)。锚点校验用,见 §5。 */
  historyCount: number;
  /** 历史年份 → 该 ytd 档累计值。算剩余月贡献下界用。 */
  history: Record<number, number>;
}

/**
 * 从一个 `ytd/N` 响应里读出本年值 + 历史序列。
 *
 * `month` 是该档的月份 N(用于拼 `YYYYMM` 键)。
 */
export function readSeries(series: NceiSeries | null, year: number, month: number): SeriesRead {
  const out: SeriesRead = { currentValue: null, currentPreliminary: false, historyCount: 0, history: {} };
  if (!series || typeof series !== "object") return out;
  const mm = String(month).padStart(2, "0");
  for (const [key, raw] of Object.entries(series)) {
    if (!/^\d{6}$/.test(key)) continue;
    if (key.slice(4) !== mm) continue; // 只取同月档的键
    const y = Number(key.slice(0, 4));
    const v = parseNceiValue(raw);
    if (v === null) continue;
    if (y === year) {
      out.currentValue = v;
      out.currentPreliminary = isPreliminary(raw);
    } else {
      out.history[y] = v;
      out.historyCount += 1;
    }
  }
  return out;
}

export interface RemainderStats {
  /** 窗口内"全年 − 该 ytd 档"的最小值。null = 样本不足。 */
  minRemainder: number | null;
  /** 中位数,给人看的参考。 */
  medianRemainder: number | null;
  /** 参与统计的年份数。 */
  sampleYears: number;
  /** 实际使用的窗口起始年(含)。 */
  fromYear: number | null;
  /** 逐年明细,进日志便于复核。 */
  perYear: Array<{ year: number; ytd: number; full: number; remainder: number }>;
}

/**
 * 算"剩余月份贡献"的历史分布。
 *
 * ⚠ 只用**两边都有数据**的年份配对。单边缺失的年份必须整年丢掉 ——
 * 若把缺 full 的年份当成 remainder=0,`minRemainder` 会被压到 0,
 * 下界判据当场失效(而且日志上只表现为一个偏小的数字,不会报错)。
 *
 * ⚠⚠ **`windowYears` 不是调参,是判据的一部分,必须显式传。**
 * 2026-08-08 实测:NCEI 序列回溯到 1950 年,全量 76 年的 `minRemainder = 49`
 * (来自 1950 年 —— 那年**全年**才 201 个龙卷),而近 20 年是 210、近 10 年是 250。
 * 拿 1950 年代的**绝对**贡献量当 2026 年的下界是量纲错误:多普勒雷达网、人口密度、
 * 手机时代的目击上报率把整个量级抬高了一个台阶。
 * 但反过来只取三四年样本又太少,一个异常年就能左右结论。
 *
 * 这个判据**对窗口选择敏感**(1141 + 49 = 1190 不过阈,1141 + 210 = 1351 过阈),
 * 所以 `tornadoVerdict` 的 detail 里必须把多个窗口的结果一起报出来 ——
 * 敏感性要**可见**,而不是被一个默认值藏起来。
 */
export function remainderStats(
  ytd: Record<number, number>,
  full: Record<number, number>,
  windowYears: number,
  targetYear: number
): RemainderStats {
  const fromYear = targetYear - windowYears;
  const per: RemainderStats["perYear"] = [];
  for (const [ys, v] of Object.entries(ytd)) {
    const y = Number(ys);
    if (y < fromYear || y >= targetYear) continue; // 窗口外 / 目标年自身都不参与
    const f = full[y];
    if (typeof f !== "number") continue;
    const rem = f - v;
    // 负的 remainder 只可能来自数据错位(全年 < 年内累计),不是"剩余月为负"。
    // 静默丢弃会掩盖端点变更,所以留在 perYear 里但不进统计。
    per.push({ year: y, ytd: v, full: f, remainder: rem });
  }
  per.sort((a, b) => a.year - b.year);
  const valid = per.filter((p) => p.remainder >= 0).map((p) => p.remainder).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { minRemainder: null, medianRemainder: null, sampleYears: 0, fromYear, perYear: per };
  }
  const mid = Math.floor(valid.length / 2);
  const median = valid.length % 2 === 1 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2;
  return { minRemainder: valid[0]!, medianRemainder: median, sampleYears: valid.length, fromYear, perYear: per };
}

export type WatchState =
  | "unreadable"
  | "waiting"
  | "below"
  | "bound-lost"
  | "bound-clears"
  | "printed-clears";

export interface WatchVerdict {
  state: WatchState;
  severity: "info" | "warn" | "crit";
  headline: string;
  detail: string;
  /** 去重键。null = 本态每轮都发(本脚本不用)。 */
  dedupeKey: string | null;
  notify: boolean;
  /** 算术下界(最新累计 + 剩余月历史最小贡献)。null = 算不出。 */
  lowerBound: number | null;
}

export interface VerdictInput {
  /** 探测到的最新已发布月(1..12)。null = 一个都没探到。 */
  latestMonth: number | null;
  latestValue: number | null;
  latestPreliminary: boolean;
  /** 该档的历史键数,锚点校验用。 */
  historyCount: number;
  /** 判定所用的那个窗口(见 DECISION_WINDOW_YEARS)。 */
  remainder: RemainderStats;
  /**
   * 之前是否曾判过下界过阈(由 sentinel 文件的存在推出)。
   *
   * 用途只有一个:把"一直没过阈"(正常,静默)与"过阈后又跌回去"(坏消息,必须告警)
   * 分开。没有这个位的话,NCEI 一次向下修订会让状态从 bound-clears 静静退回 below ——
   * 而 below 是静默态,**没有任何人会知道判据已经失效了**。
   */
  everCleared: boolean;
  /**
   * 其他窗口的 minRemainder,用于把判据的**窗口敏感性**写进告警正文。
   * 键是窗口年数。判定不看它,人看。
   */
  sensitivity?: Record<number, number | null>;
  threshold: number;
  dayKey: string;
  hourKey: string;
}

/** 把敏感性渲染成一行,给 detail 用。 */
function renderSensitivity(latest: number, threshold: number, s?: Record<number, number | null>): string {
  if (!s || Object.keys(s).length === 0) return "";
  const rows = Object.entries(s)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([w, min]) => {
      if (min === null) return `  近 ${w} 年:样本不足`;
      const b = latest + min;
      return `  近 ${w} 年:最小贡献 ${min} ⟹ 下界 ${b} ${b >= threshold ? "✓ 过阈" : "✗ 不过阈"}`;
    });
  return `\n\n**窗口敏感性**(这个判据对取多少年样本敏感,故并列):\n${rows.join("\n")}`;
}

/**
 * 五态判定。
 *
 * ```
 * printed-clears  已印累计值本身 ≥ 阈值            → 最强(仍非条款棘轮)
 * bound-clears    已印值 + 剩余月历史最小 ≥ 阈值    → 算术下界过阈,依赖经验假设
 * below           下界 < 阈值                      → 未锁定,继续等
 * waiting         端点正常但本年该月未发布          → 刻意静默
 * unreadable      连历史锚点都读不到                → 告警
 * ```
 *
 * `printed-clears` 与 `bound-clears` 分开,是因为两者的**推翻条件不同**:
 * 前者只怕已印数字被下修;后者还多一条"剩余月贡献跌破历史最小"。
 * 合并成一个 "locked" 会把两种不同强度的证据混同 —— 正是 Oregon 复盘里
 * "unlikely 被包装成明牌"那类错误的源头。
 */
export function tornadoVerdict(i: VerdictInput): WatchVerdict {
  // ① 端点/解析失效。历史锚点是唯一能把它与"未发布"分开的证据(§5)。
  if (i.latestMonth === null || i.historyCount === 0) {
    return {
      state: "unreadable",
      severity: "warn",
      headline: "NCEI 龙卷序列读不到",
      detail:
        `探测到的最新月=${i.latestMonth ?? "无"},历史锚点键数=${i.historyCount}。` +
        `历史键为 0 说明端点或字段结构变了(不是"本月未发布" —— 那种情况历史键仍在)。` +
        `⚠ NCEI 有瞬时限流,本脚本已带重试;仍读不到才会到这里。`,
      dedupeKey: `unreadable-${i.hourKey}`,
      notify: true,
      lowerBound: null,
    };
  }

  // ② 端点正常,但本年该月还没印。刻意静默 —— 这是绝大多数轮次的正常状态。
  if (i.latestValue === null) {
    return {
      state: "waiting",
      severity: "info",
      headline: `${YEAR} 年数据尚未发布(端点正常)`,
      detail: `ytd/${i.latestMonth} 档历史键 ${i.historyCount} 个可读,但无 ${YEAR}${String(i.latestMonth).padStart(2, "0")} 键。`,
      dedupeKey: null,
      notify: false,
      lowerBound: null,
    };
  }

  const pre = i.latestPreliminary ? "(preliminary,按条款同样有效)" : "";
  const monthLabel = `Jan–${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i.latestMonth]}`;

  // ③ 已印累计值本身就过阈。最强的一档。
  if (i.latestValue >= i.threshold) {
    return {
      state: "printed-clears",
      severity: "crit",
      headline: `🎯 已印累计 ${i.latestValue} ≥ ${i.threshold} —— 算术上已达标`,
      detail:
        `NCEI ${monthLabel} ${YEAR} = ${i.latestValue}${pre},已达到或超过阈值 ${i.threshold}。\n` +
        `年度累计单调不减 ⟹ Jan–Dec 必然 ≥ ${i.latestValue}。\n\n` +
        `⚠ **这不是条款棘轮**:条款规定结算读 December 报告(约 2027-01 上旬)发布后的` +
        `第一次 Jan–Dec 累计,且明写"不据发布前的 preliminary 值结算"。\n` +
        `唯一残余风险 = NCEI 把已印月份**向下修订**到累计跌破 ${i.threshold}。`,
      dedupeKey: "printed-clears",
      notify: true,
      lowerBound: i.latestValue,
    };
  }

  // ④ 下界判据。剩余月贡献取历史最小值 —— 经验假设,不是物理上界。
  if (i.remainder.minRemainder === null) {
    return {
      state: "below",
      severity: "info",
      headline: `已印累计 ${i.latestValue} < ${i.threshold},且剩余月历史样本不足`,
      detail:
        `NCEI ${monthLabel} ${YEAR} = ${i.latestValue}${pre}。` +
        `无法算剩余月贡献下界(配对年份 0 个)—— 不做任何锁定推断。`,
      dedupeKey: `below-${i.dayKey}`,
      notify: false,
      lowerBound: null,
    };
  }

  const bound = i.latestValue + i.remainder.minRemainder;
  if (bound >= i.threshold) {
    return {
      state: "bound-clears",
      severity: "crit",
      headline: `📐 算术下界 ${bound} ≥ ${i.threshold}(已印 ${i.latestValue} + 剩余月历史最小 ${i.remainder.minRemainder})`,
      detail:
        `NCEI ${monthLabel} ${YEAR} = ${i.latestValue}${pre}。\n` +
        `剩余月份贡献的历史最小值 = ${i.remainder.minRemainder}` +
        `(中位数 ${i.remainder.medianRemainder},样本 ${i.remainder.sampleYears} 年)。\n` +
        `⟹ 下界 ${i.latestValue} + ${i.remainder.minRemainder} = **${bound}** ≥ ${i.threshold},余量 ${bound - i.threshold}。` +
        renderSensitivity(i.latestValue, i.threshold, i.sensitivity) +
        `\n\n⚠ **判定是 unlikely,不是 locked。** 依赖三条,任一破就不成立:\n` +
        `  ① 剩余月贡献不低于该窗口的历史最小值 —— 这是**经验假设**,不是物理上界;\n` +
        `  ② 窗口选得对。全量 76 年会把 1950 年代(全年才 200 个)的绝对贡献量算进来,\n` +
        `     那是量纲错误;本判定用 ${i.remainder.fromYear ?? "?"} 年起的样本` +
        `(${i.remainder.sampleYears} 年);\n` +
        `  ③ NCEI 不把已印月份向下修订(去重/跨县合并会向下修)。\n` +
        `条款结算要等 December 报告(约 2027-01 上旬)⟹ 占资约 5 个月,算年化时别忘。`,
      // 永久去重:这是"下界首次过阈"这个**事件**的通知,不是状态播报。
      // 按天去重会在结算前的 5 个月里发出约 150 封同样内容的信,真事件会被埋掉。
      dedupeKey: "bound-clears",
      notify: true,
      lowerBound: bound,
    };
  }

  // 曾过阈、现在又掉下来 —— 这是坏消息,必须打破静默。
  if (i.everCleared) {
    return {
      state: "bound-lost",
      severity: "crit",
      headline: `⚠️ 下界跌回阈值下:${bound} < ${i.threshold}(曾判过阈)`,
      detail:
        `NCEI ${monthLabel} ${YEAR} = ${i.latestValue}${pre};剩余月历史最小 ${i.remainder.minRemainder}` +
        ` ⟹ 下界 ${bound},距阈值差 ${i.threshold - bound}。\n\n` +
        `**之前曾判定下界过阈,现在退回来了。** 只有两种成因:\n` +
        `  ① NCEI 把已印月份**向下修订**了(去重/跨县合并);\n` +
        `  ② 历史窗口的最小贡献值变了(新的一年进入窗口、老的一年移出)。\n` +
        `若已按当时判定建过仓,**这一条直接影响在险金额**,请复核。`,
      dedupeKey: `bound-lost-${i.dayKey}`,
      notify: true,
      lowerBound: bound,
    };
  }

  return {
    state: "below",
    severity: "info",
    headline: `下界 ${bound} < ${i.threshold},未锁定`,
    detail:
      `NCEI ${monthLabel} ${YEAR} = ${i.latestValue}${pre};剩余月历史最小 ${i.remainder.minRemainder}` +
      ` ⟹ 下界 ${bound},距阈值还差 ${i.threshold - bound}。继续等后续月报。`,
    dedupeKey: `below-${i.dayKey}`,
    notify: false,
    lowerBound: bound,
  };
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface EvResult {
  shares: number;
  costUsd: number;
  avgPrice: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  returnPct: number;
  breakEven: number;
  ladder: string;
}

/**
 * 按 ≤ maxPrice 的档位逐档吃,算净利。
 *
 * 费公式 `rate × p × (1−p) × 股数` —— **基数是股数,不是成交额**
 * (2026-08-08 Oregon 复盘踩过这个错,净利虚高 $0.92)。
 * `minSize` 用于滤掉不可独立成交的残档(orderMinSize,实测 5 股)。
 */
export function evFromBook(levels: BookLevel[], maxPrice: number, feeRate: number, minSize = 0): EvResult {
  let shares = 0;
  let cost = 0;
  let fee = 0;
  const parts: string[] = [];
  for (const l of levels) {
    const p = Number(l.price);
    const s = Number(l.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0 || p <= 0) continue;
    if (p > maxPrice) continue;
    if (s < minSize) continue; // 残档:低于最小下单量,吃不到
    shares += s;
    cost += p * s;
    fee += feeRate * p * (1 - p) * s;
    parts.push(`${p}×${s}`);
  }
  const gross = shares - cost;
  const avg = shares > 0 ? cost / shares : 0;
  return {
    shares,
    costUsd: cost,
    avgPrice: avg,
    grossUsd: gross,
    feeUsd: fee,
    netUsd: gross - fee,
    returnPct: cost > 0 ? ((gross - fee) / cost) * 100 : 0,
    breakEven: avg > 0 ? avg + feeRate * avg * (1 - avg) : 0,
    ladder: parts.join(" "),
  };
}

export interface IdentityResult {
  ok: boolean;
  problems: string[];
}

/**
 * 方向双向锁 + 活性检查。
 *
 * Gamma 的 `outcomes` / `clobTokenIds` 是两个平行数组,靠**下标对齐**决定方向。
 * 一次平台侧顺序变更就能让"取 Yes 腿"静默取到 No。本盘同 event 有 8 档、
 * 且 slug 有过克隆史(见 §7),方向错不是少赚而是本金归零。
 */
export function identityCheck(m: Record<string, unknown> | null | undefined): IdentityResult {
  const problems: string[] = [];
  if (!m) return { ok: false, problems: ["Gamma 未返回该 market"] };

  if (String(m.conditionId ?? "").toLowerCase() !== CONDITION_ID.toLowerCase()) {
    problems.push(`conditionId 不符:${String(m.conditionId)}`);
  }
  if (String(m.id ?? "") !== MARKET_ID) problems.push(`market id 不符:${String(m.id)}`);

  let outcomes: unknown = m.outcomes;
  let tokens: unknown = m.clobTokenIds;
  try {
    if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  } catch {
    problems.push("outcomes 不是合法 JSON");
  }
  try {
    if (typeof tokens === "string") tokens = JSON.parse(tokens);
  } catch {
    problems.push("clobTokenIds 不是合法 JSON");
  }
  if (!Array.isArray(outcomes) || !Array.isArray(tokens)) {
    problems.push("outcomes/clobTokenIds 不是数组");
    return { ok: false, problems };
  }
  const yesIdx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === "yes");
  if (yesIdx < 0) problems.push(`outcomes 里没有 "Yes":${JSON.stringify(outcomes)}`);
  else if (String(tokens[yesIdx] ?? "") !== YES_TOKEN_ID) {
    // 第二把锁:下标指向 Yes **且**那个位置的 tokenId 逐字等于写死常量。
    problems.push(`outcomes[${yesIdx}]="Yes" 但 tokenId 不等于写死常量(平台侧顺序可能已变更)`);
  }

  if (m.closed === true) problems.push("市场已 closed");
  if (m.acceptingOrders === false) problems.push("acceptingOrders=false");
  // 已结算盘的 umaResolutionStatuses 会停在 ["proposed"],不能拿 proposed 当"未终局"。
  if (m.umaResolutionStatus === "resolved") problems.push("umaResolutionStatus=resolved");

  const desc = String(m.description ?? "");
  // 条款三句关键句。任一消失说明条款被改过,判据可能已不适用。
  for (const [label, needle] of [
    ["结算源 NCEI", "ncei.noaa.gov/access/monitoring/tornadoes/time-series"],
    ["preliminary governs", "it will still determine resolution"],
    ["发布前 preliminary 不算", "not resolve based on any preliminary values published before"],
  ] as const) {
    if (!desc.includes(needle)) problems.push(`条款关键句缺失(${label})`);
  }

  return { ok: problems.length === 0, problems };
}

const dayKey = (now: Date): string => now.toISOString().slice(0, 10).replace(/-/g, "");
const hourKey = (now: Date): string => now.toISOString().slice(0, 13).replace(/[-T]/g, "");

const sentinelPath = (key: string): string => path.join(ROOT, "data", `tornado-notified-${key}`);

/**
 * 之前是否曾判过阈。靠 `bound-clears` / `printed-clears` 两个永久 sentinel 的存在推出。
 *
 * 用 sentinel 而不是另开一个状态文件,是因为它已经因去重而必须存在 ——
 * 多一个状态文件就多一处可能与 sentinel 不一致的真相来源。
 */
function hasCleared(): boolean {
  return fs.existsSync(sentinelPath("bound-clears")) || fs.existsSync(sentinelPath("printed-clears"));
}

// ══ IO 区 ═══════════════════════════════════════════════════════

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试的 JSON 取数。
 *
 * NCEI 瞬时限流实测:首读 200 → 随后 25s/60s 两次全超时 → 3 分钟后恢复。
 * 所以退避必须**跨到分钟量级**,3 次 800ms 的退避在这个失败模式下等于没重试。
 */
async function getJson<T>(url: string, tries = 4, timeoutMs = 30_000): Promise<T | null> {
  const backoff = [2_000, 15_000, 45_000];
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
      clearTimeout(t);
      if (r.ok) return (await r.json()) as T;
      emit({ kind: "fetch-retry", url, status: r.status, attempt: i + 1 });
    } catch (err) {
      emit({ kind: "fetch-retry", url, err: err instanceof Error ? err.message : String(err), attempt: i + 1 });
    }
    if (i < tries - 1) await sleep(backoff[Math.min(i, backoff.length - 1)]!);
  }
  return null;
}

interface NceiResponse {
  description?: { title?: string; preliminary?: string };
  tornadoes?: NceiSeries;
}

/**
 * 探测最新已发布月。从 (当前月 − 1) 向下试,最多 `maxProbe` 档。
 *
 * 不按发布日推算,是因为每月发布日、时区、以及延迟发布的可能性都要建模,
 * 而探测只依赖"数据在不在",天然正确。
 */
async function probeLatest(nowMonth: number, maxProbe = 4): Promise<{ month: number; read: SeriesRead } | null> {
  for (let k = 0; k < maxProbe; k++) {
    const m = nowMonth - 1 - k;
    if (m < 1) break;
    const res = await getJson<NceiResponse>(`${NCEI}/ytd/${m}/data.json`);
    if (!res) {
      emit({ kind: "probe", month: m, result: "fetch-failed" });
      continue;
    }
    const read = readSeries(res.tornadoes ?? null, YEAR, m);
    emit({
      kind: "probe",
      month: m,
      title: res.description?.title,
      currentValue: read.currentValue,
      preliminary: read.currentPreliminary,
      historyKeys: read.historyCount,
    });
    if (read.currentValue !== null) return { month: m, read };
    // 本年该月未发布,但历史键在 ⟹ 端点正常,继续往下探更早的月份。
    if (read.historyCount > 0) continue;
    // 历史键也没了 ⟹ 结构变了,再往下探也没意义。
    return { month: m, read };
  }
  return null;
}

async function readBook(): Promise<BookLevel[] | null> {
  const res = await getJson<{ asks?: Array<{ price: string; size: string }> }>(
    `${CLOB}/book?token_id=${YES_TOKEN_ID}`,
    3,
    20_000
  );
  if (!res || !Array.isArray(res.asks)) return null;
  // CLOB 的 asks 是价格降序,吃单要从最低价开始。
  return res.asks
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price);
}

async function notify(v: WatchVerdict): Promise<void> {
  if (NO_MAIL) {
    emit({ kind: "mail-skipped", reason: "--no-mail", state: v.state });
    return;
  }
  if (v.dedupeKey) {
    const flag = sentinelPath(v.dedupeKey);
    if (fs.existsSync(flag)) {
      emit({ kind: "mail-suppressed", state: v.state, key: v.dedupeKey });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      fs.writeFileSync(flag, new Date().toISOString());
    } catch (err) {
      // 写不进 sentinel 就照常发信 —— 宁可多一封,不可漏告警。
      emit({ kind: "warn", msg: `sentinel 写入失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const icon = v.severity === "crit" ? "🎯" : v.severity === "warn" ? "⚠️" : "ℹ️";
  const subject = `${icon} tornado-watch: ${v.headline}`;
  const html =
    `<h2>${v.headline}</h2><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${v.detail}</pre>` +
    `<p><a href="${MARKET_URL}">${SLUG}</a></p>`;
  try {
    const { sendMail } = await import("./mailer");
    await sendMail({ subject, html, text: `${v.headline}\n\n${v.detail}\n\n${MARKET_URL}` });
    emit({ kind: "mail-sent", state: v.state, subject });
  } catch (err) {
    emit({ kind: "mail-failed", state: v.state, err: err instanceof Error ? err.message : String(err) });
  }
}

async function main(): Promise<void> {
  const now = new Date();
  emit({ kind: "start", slug: SLUG, threshold: THRESHOLD, year: YEAR, simulate: SIMULATE, noBook: NO_BOOK });

  if (SIMULATE) {
    const v = tornadoVerdict({
      latestMonth: SIMULATE === "unreadable" ? null : 7,
      latestValue:
        SIMULATE === "waiting"
          ? null
          : SIMULATE === "printed-clears"
            ? 1274
            : SIMULATE === "below" || SIMULATE === "bound-lost"
              ? 900
              : 1141,
      latestPreliminary: true,
      historyCount: SIMULATE === "unreadable" ? 0 : 70,
      remainder: { minRemainder: 210, medianRemainder: 357, sampleYears: 20, fromYear: 2006, perYear: [] },
      sensitivity: { 5: 250, 10: 250, 20: 210, 40: 169, 80: 49 },
      everCleared: SIMULATE === "bound-lost",
      threshold: THRESHOLD,
      dayKey: dayKey(now),
      hourKey: hourKey(now),
    });
    emit({ kind: "verdict", simulated: SIMULATE, ...v });
    if (v.notify) await notify(v);
    return;
  }

  // ── 身份与活性(方向双向锁)────────────────────────────────────
  const mArr = await getJson<Array<Record<string, unknown>>>(`${GAMMA}/markets?slug=${SLUG}`, 3, 20_000);
  const market = Array.isArray(mArr) ? mArr[0] : null;
  const id = identityCheck(market);
  emit({ kind: "identity", ok: id.ok, problems: id.problems });
  if (!id.ok) {
    // 身份不符不代表数据面判定无效,但**下单相关的一切结论都作废**,所以要告警。
    await notify({
      state: "unreadable",
      severity: "warn",
      headline: "身份/活性检查未通过 —— 盘面结论作废",
      detail: id.problems.join("\n"),
      dedupeKey: `identity-${hourKey(now)}`,
      notify: true,
      lowerBound: null,
    });
  }

  const feeRate = ((): number => {
    const fs2 = market?.feeSchedule as { rate?: number } | undefined;
    if (market?.feesEnabled === false) return 0; // 实测存在 feesEnabled=false 的盘,真费为 0
    return typeof fs2?.rate === "number" ? fs2.rate : FEE_RATE_FALLBACK;
  })();
  const minSize = typeof market?.orderMinSize === "number" ? market.orderMinSize : 5;

  // ── 数据面 ───────────────────────────────────────────────────
  const probed = await probeLatest(now.getUTCMonth() + 1);
  const fullRes = await getJson<NceiResponse>(`${NCEI}/ytd/12/data.json`);
  const fullRead = readSeries(fullRes?.tornadoes ?? null, YEAR, 12);
  const ytdHist = probed?.read.history ?? {};

  // 判定用 DECISION_WINDOW_YEARS;其余窗口只用来把敏感性写进告警正文。
  const rem = remainderStats(ytdHist, fullRead.history, DECISION_WINDOW_YEARS, YEAR);
  const sensitivity: Record<number, number | null> = {};
  for (const w of SENSITIVITY_WINDOWS) {
    sensitivity[w] = remainderStats(ytdHist, fullRead.history, w, YEAR).minRemainder;
  }
  emit({
    kind: "remainder",
    decisionWindow: DECISION_WINDOW_YEARS,
    fromYear: rem.fromYear,
    minRemainder: rem.minRemainder,
    median: rem.medianRemainder,
    sampleYears: rem.sampleYears,
    sensitivity,
    perYear: rem.perYear,
  });

  const v = tornadoVerdict({
    latestMonth: probed?.month ?? null,
    latestValue: probed?.read.currentValue ?? null,
    latestPreliminary: probed?.read.currentPreliminary ?? false,
    historyCount: probed?.read.historyCount ?? 0,
    remainder: rem,
    sensitivity,
    everCleared: hasCleared(),
    threshold: THRESHOLD,
    dayKey: dayKey(now),
    hourKey: hourKey(now),
  });
  emit({ kind: "verdict", ...v });

  // ── 盘面(仅供决策,本脚本不下单)──────────────────────────────
  if (!NO_BOOK) {
    const levels = await readBook();
    if (!levels) {
      emit({ kind: "book", ok: false, note: "CLOB book 读不到(error 对象/超时);不折叠成深度 0" });
    } else {
      const ev = evFromBook(levels, MAX_PRICE, feeRate, minSize);
      emit({ kind: "book", ok: true, feeRate, minSize, maxPrice: MAX_PRICE, ...ev });
    }
  }

  if (v.notify) await notify(v);
  emit({ kind: "done", state: v.state, lowerBound: v.lowerBound });
}

// 项目惯例:纯函数区被 tests/ import,不能在 import 时把 main() 跑起来
// (否则离线回归会打真实网络、还会往 data/ 里写 jsonl)。
if (require.main === module) {
  void main();
}
