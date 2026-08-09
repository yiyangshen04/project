/**
 * USDM 干旱盘全州扫描器 —— Oregon 那条一次性狙击的泛化(2026-08-08 建)。
 *
 * ── 它做什么、以及刻意不做什么 ─────────────────────────────────
 * oregon-sniper 是**单盘执行体**:标的写死、方向写死、会下单。
 * 本脚本是**多盘侦察兵**:遍历 Gamma 上所有 US Drought Monitor 型盘,
 * 把每条的「条款阈值 vs 该州 USDM 实测值 vs 盘面 ask」自动比对成一个判定,
 * 然后**只报告,永不下单**。
 *
 * 为什么把执行拿掉(这是本脚本最重要的一条设计):
 * oregon-sniper 的方向安全建立在**双向锁**上 —— tokenId 写死成常量,启动时
 * 与 Gamma 返回的 `outcomes[yesIdx]` 逐字比对,两边都过才认。Gamma 的
 * `outcomes`/`clobTokenIds` 是靠**下标对齐**的两个平行数组,一次平台侧顺序
 * 变更就能让"取 Yes 腿"静默取到 No,而这类盘 YES 必然 $1 / NO 必然 $0 ——
 * 方向错不是少赚,是本金归零。
 * 扫描器事先不知道要扫到哪些盘,**写不出那个常量**,于是双向锁的第二把锁天然
 * 缺失。补偿办法不是"换个弱一点的校验凑合下单",而是分层:
 *   扫描器负责发现 → 人工确认 → 把常量钉进一个 oregon-sniper 式的执行体 → 下单。
 * 多花的那 20 分钟,换掉的是一条能让本金归零的静默路径。
 *
 * ── 四类判定(棘轮条款的完整状态空间)───────────────────────────
 *   triggered        历史任一期已达标 ⟹ 棘轮已锁,YES 必然 $1。买 YES。
 *   impossible-hard  截止前**已无更多发布**且从未达标 ⟹ NO 必然 $1。买 NO。
 *   impossible-soft  物理上界 < 阈值 ⟹ 强推定 NO(依赖一条经验假设,见 reachBound)。
 *   unlikely         上界够得到,但历史全程远低于阈值且趋势在改善 ⟹ 薄利 NO,
 *                    **给材料不给结论**(概率判断,不是明牌 —— 见下)。
 *   open             真的未定。
 *   unreadable       数据读不到。**绝不折叠进上面任何一档**。
 *
 * `unlikely` 与 `impossible-*` 的分界是本脚本的诚实性所在:2026-08-08 实测
 * Virginia D4 —— 8 期全 0、D3 从 32.52% 单调改善到 4.19%、NO 腿 ask 0.95 ——
 * 看起来像明牌,但剩 3 期发布、当前 D3 及以上面积 4.19% ≥ 阈值 1.00%,
 * **物理上界够得到**。把它标成 impossible 就是把一个 5% 回报的概率押注
 * 包装成无风险套利。它是 `unlikely`,不是 `impossible`。
 *
 * ── 三个已实测的坑(改代码前先读)────────────────────────────────
 * 1. `aoi` 必须是**两位零填充**的 FIPS 码。`aoi=41`(Oregon)能用纯粹因为它
 *    本来就两位;`aoi=1`(Alabama)返回 `[]` + HTTP 200,`aoi=01` 才对。
 *    AL/AK/AZ/AR/CA/CO/CT 这 7 个州若用 `String(fips)` 会**全部静默失效**。
 * 2. 跨口径恒等式**每个等级不同**。cumulative 是"该级及以上"的累计:
 *    `cum.dK = Σ(cat.dK … cat.d4)`。只有 K=4 时两者恒等(无更高级可累加)——
 *    oregon-sniper 里那条 `c.d4 === u.d4` 的硬校验**只对 D4 成立**,
 *    照搬到 D0–D3 会把完全正常的数据判成 unreadable。
 * 3. 空数组 + HTTP 200 是这个 API 的静默失败形态,与"该州无数据"不可区分。
 *    一律 unreadable,**绝不读成 0**。读成 0 会让每一条 "reach D4" 盘
 *    看起来都是 impossible —— 全表明牌,全表错。
 *
 * 用法:
 *   ./run-cron.sh scripts/usdm-scan.ts                    # 全扫,表格输出
 *   ./run-cron.sh scripts/usdm-scan.ts --json             # 机读输出
 *   ./run-cron.sh scripts/usdm-scan.ts --state VA         # 只看一个州
 *   ./run-cron.sh scripts/usdm-scan.ts --data-only        # 不碰 Gamma,只出 50 州数据面
 *   ./run-cron.sh scripts/usdm-scan.ts --no-book          # 跳过盘口(快,只做数据面比对)
 *   ./run-cron.sh scripts/usdm-scan.ts --mail --min-net 20  # cron:净利≥$20 才发信
 *
 * 参数:
 *   --state <ABBR>     只扫某州(可重复)
 *   --data-only        只拉 50 州 USDM 数据面,不查 Gamma、不查盘口
 *   --no-book          查 Gamma 但不拉 CLOB book(EV 字段留空)
 *   --max-price <价>   EV 计算的追高闸,默认 0.97(扫描器口径比执行体宽一档:
 *                      它的任务是"把肉报全"而不是"决定吃到哪一档")
 *   --min-net <美元>   只报净利 ≥ 此值的机会(表格仍显示全部,邮件按此过滤)
 *   --weeks <N>        拉最近 N 期历史,默认 12(覆盖多数盘的 creation 至今)
 *   --json             JSON 输出到 stdout
 *   --out <路径>       jsonl 落盘,默认 data/usdm-scan.jsonl
 *   --mail             有 triggered / impossible-hard 时发邮件(默认不发)
 *   --concurrency <N>  USDM 取数并发,默认 4(源是 .edu 小站,别打挂它)
 */
import fs from "node:fs";
import path from "node:path";
import { CLOB_API, GAMMA_API } from "../lib/polymarket/config";

// ══ 常量 ══════════════════════════════════════════════════════

const USDM_API = "https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent";

/**
 * 州 → FIPS 数字码。**存成两位零填充的字符串,不是 number。**
 *
 * 2026-08-08 实测:`aoi=01` 返回 Alabama,`aoi=1` 返回 `[]` + HTTP 200。
 * 存 number 就必然要在拼 URL 时 padStart,而那个 padStart 一旦被谁"简化"掉,
 * 失败形态是 7 个州静默消失(而不是报错)。存字符串让这件事没有发生的余地。
 */
export const STATE_FIPS: ReadonlyArray<{ abbr: string; fips: string; name: string }> = [
  { abbr: "AL", fips: "01", name: "Alabama" },
  { abbr: "AK", fips: "02", name: "Alaska" },
  { abbr: "AZ", fips: "04", name: "Arizona" },
  { abbr: "AR", fips: "05", name: "Arkansas" },
  { abbr: "CA", fips: "06", name: "California" },
  { abbr: "CO", fips: "08", name: "Colorado" },
  { abbr: "CT", fips: "09", name: "Connecticut" },
  { abbr: "DE", fips: "10", name: "Delaware" },
  { abbr: "DC", fips: "11", name: "District of Columbia" },
  { abbr: "FL", fips: "12", name: "Florida" },
  { abbr: "GA", fips: "13", name: "Georgia" },
  { abbr: "HI", fips: "15", name: "Hawaii" },
  { abbr: "ID", fips: "16", name: "Idaho" },
  { abbr: "IL", fips: "17", name: "Illinois" },
  { abbr: "IN", fips: "18", name: "Indiana" },
  { abbr: "IA", fips: "19", name: "Iowa" },
  { abbr: "KS", fips: "20", name: "Kansas" },
  { abbr: "KY", fips: "21", name: "Kentucky" },
  { abbr: "LA", fips: "22", name: "Louisiana" },
  { abbr: "ME", fips: "23", name: "Maine" },
  { abbr: "MD", fips: "24", name: "Maryland" },
  { abbr: "MA", fips: "25", name: "Massachusetts" },
  { abbr: "MI", fips: "26", name: "Michigan" },
  { abbr: "MN", fips: "27", name: "Minnesota" },
  { abbr: "MS", fips: "28", name: "Mississippi" },
  { abbr: "MO", fips: "29", name: "Missouri" },
  { abbr: "MT", fips: "30", name: "Montana" },
  { abbr: "NE", fips: "31", name: "Nebraska" },
  { abbr: "NV", fips: "32", name: "Nevada" },
  { abbr: "NH", fips: "33", name: "New Hampshire" },
  { abbr: "NJ", fips: "34", name: "New Jersey" },
  { abbr: "NM", fips: "35", name: "New Mexico" },
  { abbr: "NY", fips: "36", name: "New York" },
  { abbr: "NC", fips: "37", name: "North Carolina" },
  { abbr: "ND", fips: "38", name: "North Dakota" },
  { abbr: "OH", fips: "39", name: "Ohio" },
  { abbr: "OK", fips: "40", name: "Oklahoma" },
  { abbr: "OR", fips: "41", name: "Oregon" },
  { abbr: "PA", fips: "42", name: "Pennsylvania" },
  { abbr: "RI", fips: "44", name: "Rhode Island" },
  { abbr: "SC", fips: "45", name: "South Carolina" },
  { abbr: "SD", fips: "46", name: "South Dakota" },
  { abbr: "TN", fips: "47", name: "Tennessee" },
  { abbr: "TX", fips: "48", name: "Texas" },
  { abbr: "UT", fips: "49", name: "Utah" },
  { abbr: "VT", fips: "50", name: "Vermont" },
  { abbr: "VA", fips: "51", name: "Virginia" },
  { abbr: "WA", fips: "53", name: "Washington" },
  { abbr: "WV", fips: "54", name: "West Virginia" },
  { abbr: "WI", fips: "55", name: "Wisconsin" },
  { abbr: "WY", fips: "56", name: "Wyoming" },
  { abbr: "PR", fips: "72", name: "Puerto Rico" },
];

const FIPS_BY_ABBR = new Map(STATE_FIPS.map((s) => [s.abbr, s]));
const STATE_BY_NAME = new Map(STATE_FIPS.map((s) => [s.name.toLowerCase(), s]));

/** CLOB 最小报价档。干旱盘实测 orderPriceMinTickSize = 0.01。 */
const TICK = 0.01;

// ══ 参数 ══════════════════════════════════════════════════════

const argv = process.argv.slice(2);
const arg = (n: string): string | null => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? null) : null);
const num = (n: string, d: number): number => {
  const v = arg(n);
  if (v == null) return d;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
};
const multi = (n: string): string[] =>
  argv.reduce<string[]>((acc, a, i) => (a === n && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const ONLY_STATES = multi("--state").map((s) => s.toUpperCase());
const DATA_ONLY = argv.includes("--data-only");
const NO_BOOK = argv.includes("--no-book");
const AS_JSON = argv.includes("--json");
const MAIL = argv.includes("--mail");
/** 扫描器的追高闸比执行体(0.95)宽一档:它的任务是"把肉报全",
 * "吃到哪一档"是执行体连同 R1 概率一起做的决定,不该在侦察阶段就砍掉。 */
const MAX_PRICE = num("--max-price", 0.97);
const MIN_NET = num("--min-net", 0);
const WEEKS = Math.min(52, Math.round(num("--weeks", 12)));
const CONCURRENCY = Math.min(8, Math.round(num("--concurrency", 4)));

const ROOT = path.resolve(__dirname, "..");
const OUT = arg("--out") ?? path.join(ROOT, "data", "usdm-scan.jsonl");

let outReady = false;
function emit(row: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  if (!outReady) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    outReady = true;
  }
  fs.appendFileSync(OUT, line + "\n");
  if (!AS_JSON) console.log(line);
}

// ══ 纯函数区(导出供 tests/usdmScan.test.ts 离线锁行为)═══════════

export interface UsdmRow {
  mapDate?: string;
  stateAbbreviation?: string;
  none?: number | string;
  d0?: number | string;
  d1?: number | string;
  d2?: number | string;
  d3?: number | string;
  d4?: number | string;
  statisticFormatID?: number;
}

export type DroughtLevel = 0 | 1 | 2 | 3 | 4;

/**
 * FIPS → `aoi` 查询参数。
 *
 * 存在的唯一理由是那个前导零:`aoi=1` 返回 `[]` + HTTP 200(静默失败),
 * `aoi=01` 返回 Alabama。两位零填充是**硬要求**,不是美观问题。
 * 传进来已经是两位就原样返回,传 number 或一位数则补齐 —— 两条路都堵上,
 * 因为调用方将来可能从条款文本、CSV、别的表里拿到不同形态的 FIPS。
 */
export function aoiParam(fips: string | number): string {
  return String(fips).trim().padStart(2, "0");
}

/** 取某一等级的数值。字段名就是 d0..d4;非数一律 null(绝不当 0)。 */
export function levelValue(row: UsdmRow | null | undefined, level: DroughtLevel): number | null {
  if (!row) return null;
  const raw = (row as Record<string, unknown>)[`d${level}`];
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export interface CrossCheck {
  ok: boolean;
  problems: string[];
  /** 逐级的 (categorical 累加值, cumulative 报告值) 对照,给日志用。 */
  pairs: Array<{ level: DroughtLevel; fromCategorical: number | null; cumulative: number | null; diff: number | null }>;
}

/**
 * categorical × cumulative 的跨口径恒等式校验 —— 一条来自数据结构本身的免费断言。
 *
 * ⚠ **每个等级的公式不同**,这是从 oregon-sniper 泛化时最容易写错的地方:
 *   cumulative.dK = Σ(categorical.dK … categorical.d4)      "该级及以上"
 * 于是只有 K=4 时 `cum.d4 === cat.d4` 成立(D4 之上无更高级可累加)。
 * oregon-sniper 里那条硬校验是对的 —— 但它对的原因是它只处理 D4。
 * 把 `c.dK !== u.dK ⟹ unreadable` 照搬到 D0–D3,会把 2026-08-04 的 Virginia
 * (cat.d0=22.08 vs cum.d0=89.29)判成"两口径打架",而它其实完全正常。
 *
 * 容差 0.02:源数据是两位小数的百分比,五级累加的舍入误差最坏 ~0.02。
 * 收得更紧会产生假警,放得更松会漏掉"读到了不同期次"这种真错误。
 */
export function crossCheck(cat: UsdmRow | null, cum: UsdmRow | null, tol = 0.02): CrossCheck {
  const problems: string[] = [];
  const pairs: CrossCheck["pairs"] = [];
  if (!cat || !cum) {
    return { ok: false, problems: ["缺少 categorical 或 cumulative 行"], pairs };
  }
  const catV = ([0, 1, 2, 3, 4] as DroughtLevel[]).map((l) => levelValue(cat, l));
  const cumV = ([0, 1, 2, 3, 4] as DroughtLevel[]).map((l) => levelValue(cum, l));

  for (const l of [0, 1, 2, 3, 4] as DroughtLevel[]) {
    const tail = catV.slice(l);
    // 先窄化再累加,而不是 reduce 里 `as number` —— 那个断言会在将来某次改动
    // 把 null 悄悄当成 0 加进去,而 0 恰好是这份数据里最危险的默认值。
    const tailNums: number[] = tail.filter((v): v is number => v != null);
    const sum = tailNums.length === tail.length ? tailNums.reduce((s, v) => s + v, 0) : null;
    const rep = cumV[l];
    const diff = sum == null || rep == null ? null : Math.abs(sum - rep);
    pairs.push({ level: l, fromCategorical: sum, cumulative: rep, diff });
    if (sum == null || rep == null) {
      problems.push(`D${l} 有字段非数值,无法校验`);
    } else if ((diff as number) > tol) {
      problems.push(`D${l} 恒等式不成立:Σcat(d${l}..d4)=${sum.toFixed(2)} vs cum.d${l}=${rep.toFixed(2)}(差 ${(diff as number).toFixed(2)})`);
    }
  }
  return { ok: problems.length === 0, problems, pairs };
}

export type LevelKind = "holds" | "below" | "unreadable";

export interface LevelVerdict {
  kind: LevelKind;
  value: number | null;
  reason: string;
}

/**
 * 单期 × 单等级的三态裁决 —— oregon-sniper `usdmVerdict` 的泛化。
 *
 * 三态而非布尔的理由与原函数一字不差:`[]` + HTTP 200 是这个 API 的静默失败
 * 形态,与"该州该期无数据"不可区分。把它折进 below,每一条 "reach D4" 盘都会
 * 看起来像 impossible —— 一张全是明牌的表,而且全错。
 *
 * 与原函数的两处差异:
 *   ① 等级参数化,跨口径校验改用 crossCheck(逐级公式不同,见那里);
 *   ② `below` 取代了 `revoked`。语义变了:扫描器面对的是"这一期没达标"这个
 *      中性事实,而不是"我们持仓依赖的那一期被撤回了"那个警报。
 *      revoked 是执行体的概念,它要落 kill-switch;扫描器没有仓位可保护。
 */
export function levelVerdict(
  cat: UsdmRow[] | null,
  cum: UsdmRow[] | null,
  opts: { level: DroughtLevel; threshold: number; mapDate: string; abbr: string }
): LevelVerdict {
  const { level, threshold, mapDate, abbr } = opts;

  const pick = (rows: UsdmRow[] | null, label: string): { row: UsdmRow } | { err: string } => {
    if (rows == null) return { err: `${label} 请求失败` };
    if (!Array.isArray(rows) || rows.length === 0) {
      return { err: `${label} 返回空数组(静默失败形态:aoi 参数错与该州无数据不可区分)` };
    }
    const row = rows.find((r) => String(r.mapDate ?? "").slice(0, 10) === mapDate);
    if (!row) {
      return { err: `${label} 无 mapDate=${mapDate} 的行(拿到 ${rows.map((r) => String(r.mapDate ?? "?").slice(0, 10)).join(",")})` };
    }
    if (String(row.stateAbbreviation ?? "").toUpperCase() !== abbr.toUpperCase()) {
      return { err: `${label} stateAbbreviation=${row.stateAbbreviation ?? "?"} ≠ ${abbr}(aoi 指向了别的州)` };
    }
    return { row };
  };

  const c = pick(cat, "categorical");
  const u = pick(cum, "cumulative");
  if ("err" in c) return { kind: "unreadable", value: null, reason: c.err };
  if ("err" in u) return { kind: "unreadable", value: null, reason: u.err };

  const xc = crossCheck(c.row, u.row);
  if (!xc.ok) {
    return { kind: "unreadable", value: null, reason: `跨口径校验失败:${xc.problems.join(";")}` };
  }

  const v = levelValue(c.row, level);
  if (v == null) return { kind: "unreadable", value: null, reason: `d${level} 字段非数值` };
  return v >= threshold
    ? { kind: "holds", value: v, reason: `d${level} ${v} ≥ 阈值 ${threshold}` }
    : { kind: "below", value: v, reason: `d${level} ${v} < 阈值 ${threshold}` };
}

export interface SeriesPoint {
  mapDate: string;
  kind: LevelKind;
  value: number | null;
  reason: string;
}

export interface RatchetResult {
  triggered: boolean;
  /** 首次达标的那一期 —— 棘轮条款下,它就是结算依据。 */
  firstHitDate: string | null;
  firstHitValue: number | null;
  maxValue: number | null;
  unreadableCount: number;
  readableCount: number;
}

/**
 * 棘轮判定:窗口内**任一期**达标即永久锁定。
 *
 * "任一期"必须从**条款生效日**算起,不是"最近一期"。oregon-sniper 把 mapDate
 * 钉死在触发期是对的(它守的是一个已知触发),但扫描器不知道触发在哪一期,
 * 必须扫全窗口 —— 只看最近一期会漏掉"三周前触发过、之后回落"的盘,
 * 而那种盘恰恰是最肥的:市场已经把价格打回去了,而条款早就锁了 YES。
 *
 * unreadable 的期次**不计入达标也不计入未达标**,只计数。若窗口内有任何一期
 * 读不到,`triggered=false` 这个结论就是不完整的 —— 调用方必须看 unreadableCount,
 * 这就是把它放进返回值而不是内部吞掉的原因。
 */
export function ratchetOverSeries(points: SeriesPoint[], _threshold?: number): RatchetResult {
  let firstHitDate: string | null = null;
  let firstHitValue: number | null = null;
  let maxValue: number | null = null;
  let unreadableCount = 0;
  let readableCount = 0;

  const sorted = [...points].sort((a, b) => a.mapDate.localeCompare(b.mapDate));
  for (const p of sorted) {
    if (p.kind === "unreadable") {
      unreadableCount += 1;
      continue;
    }
    readableCount += 1;
    if (p.value != null && (maxValue == null || p.value > maxValue)) maxValue = p.value;
    if (p.kind === "holds" && firstHitDate == null) {
      firstHitDate = p.mapDate;
      firstHitValue = p.value;
    }
  }
  return { triggered: firstHitDate != null, firstHitDate, firstHitValue, maxValue, unreadableCount, readableCount };
}

/**
 * 剩余合规发布次数。USDM 每周四发布(数据截至前一个周二)。
 *
 * 条款计的是**发布日**(publication date),不是数据的 valid date —— Oregon/Virginia
 * 两条盘的 description 都有一整段专门写这件事。所以这里数的是 cutoff 之前
 * 还有几个周四,与 mapDate 无关。
 *
 * 边界:`from` 当天若是周四,视为**已发布**(该期已在历史序列里)而不计入剩余;
 * cutoff 当天若是周四则计入(条款写的是 "through <date> 11:59:59 PM ET")。
 * 时区:一律按 UTC 日期比较。USDM 发布在 08:30 ET = 12:30 UTC,同日;
 * cutoff 的 ET 午夜换算成 UTC 会落到次日 04:00,对"数周四个数"这件事影响不了
 * 一整天,故不做小时级换算 —— 若某天真的卡在边界上,`remainingDates` 会把
 * 具体日期列出来供人工判断。
 */
export function remainingReleases(fromIso: string, cutoffIso: string): { count: number; dates: string[] } {
  const from = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const cutoff = new Date(`${cutoffIso.slice(0, 10)}T00:00:00Z`);
  const dates: string[] = [];
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(cutoff.getTime())) return { count: 0, dates };

  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + 1); // from 当天不算(那一期若已发布,已在历史里)
  while (d.getTime() <= cutoff.getTime()) {
    if (d.getUTCDay() === 4) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { count: dates.length, dates };
}

/**
 * 剩余 N 期后该等级的**物理上界**。
 *
 * 判据:cumulative 的 `cum.dK` = "目前处于 DK 及以上的国土面积占比"。要让
 * `d4` 涨到 x,那 x 的面积必须先经过 D3、D2……逐级恶化上来。若假设**每期最多
 * 恶化一级**,则:
 *   1 期后 d4 ≤ cum.d3    2 期后 d4 ≤ cum.d2    3 期后 d4 ≤ cum.d1
 *   4 期后 d4 ≤ cum.d0    5 期及以上 → 100(无约束)
 * 一般式:N 期后 dL ≤ cum.d(L−N),L−N < 0 时取 100。
 *
 * ⚠ **"每期最多升一级"是经验假设,不是数学定理。** USDM 是客观指标 + 人工
 * 制图的混合产物,极端事件下单周跳两级是可能的。所以基于它的判定叫
 * `impossible-soft` 而不是 `impossible` —— 命名本身就是这条免责声明的载体。
 * 真正无假设的硬判定只有一条:剩余发布次数为 0(见 scanVerdict)。
 *
 * 另一个方向上它是**保守**的:它假设"整个 D(L−N) 及以上区域全部逐周恶化到
 * 顶级"这种从未发生过的极端,所以当它都够不到阈值时,结论相当扎实。
 */
export function reachBound(cum: UsdmRow | null, level: DroughtLevel, remaining: number): number | null {
  if (remaining <= 0) return 0; // 没有更多发布了,值不会再变
  const idx = level - remaining;
  if (idx < 0) return 100;
  const v = levelValue(cum, idx as DroughtLevel);
  return v;
}

export type ScanKind =
  | "triggered"
  | "impossible-hard"
  | "impossible-soft"
  | "unlikely"
  | "open"
  | "unreadable";

export interface ScanVerdict {
  kind: ScanKind;
  side: "YES" | "NO" | "none";
  reason: string;
  /** 依赖了"每期最多升一级"这条经验假设吗?impossible-soft 与部分 unlikely 会是 true。 */
  assumptionBased: boolean;
}

export interface ScanInput {
  /** **条款窗口内**(market creation → 今)的棘轮结果。triggered/impossible 只认它。 */
  ratchet: RatchetResult;
  /** 最近一期的 cumulative 行,用来算物理上界。 */
  latestCum: UsdmRow | null;
  level: DroughtLevel;
  threshold: number;
  remaining: number;
  /** 历史读得到的期数;太少则不足以支撑 unlikely 这种统计性结论。 */
  readableCount: number;
  /**
   * **更长的基线序列**统计(默认 --weeks 期,不受条款窗口裁剪)。
   *
   * 为什么必须与 ratchet 分开:条款只认 "from market creation" 之后的发布,
   * 所以棘轮判定只能看窗口内 —— Virginia 盘 07-21 创建,窗口内只有 3 期。
   * 但"这个州会不会突然冒出 D4"是关于**该州干旱基线**的问题,3 期样本什么
   * 都说明不了,而 12 期能。用窗口内的 3 期去做统计判断,会把每一条新创建的
   * 盘都推回 open,统计维度形同虚设;反过来用 12 期去做棘轮判定,则会把
   * 创建之前的达标算进来 —— 那是条款明确排除的,方向直接反掉。
   */
  baseline?: { count: number; maxValue: number | null };
}

/**
 * 六态综合裁决。优先级从上到下,**第一条命中即返回**。
 *
 * 顺序不是风格问题:triggered 必须压过一切(棘轮已锁,后续数据与结论无关),
 * unreadable 必须压过所有"未达标"类结论(没读到 ≠ 没达标),
 * impossible-hard(无假设)必须压过 impossible-soft(有假设)。
 */
export function scanVerdict(i: ScanInput): ScanVerdict {
  const { ratchet, latestCum, level, threshold, remaining, readableCount } = i;
  // 统计维度默认回落到窗口内 —— 调用方没给基线时,行为与旧签名一致。
  const base = i.baseline ?? { count: readableCount, maxValue: ratchet.maxValue };

  // ① 棘轮已锁 —— 这是唯一一条"后续数据无关"的结论。
  if (ratchet.triggered) {
    return {
      kind: "triggered",
      side: "YES",
      reason: `${ratchet.firstHitDate} 那期 d${level}=${ratchet.firstHitValue} ≥ ${threshold},棘轮条款已锁定 YES`,
      assumptionBased: false,
    };
  }

  // ② 没读到就是没读到。放在"未达标"类结论之前 —— 否则一次 aoi 传错
  //    会把全表判成明牌 NO。
  if (readableCount === 0) {
    return { kind: "unreadable", side: "none", reason: "窗口内无任何可读期次", assumptionBased: false };
  }
  if (ratchet.unreadableCount > 0) {
    return {
      kind: "unreadable",
      side: "none",
      reason: `窗口内有 ${ratchet.unreadableCount} 期读不到 —— "从未达标"这个结论不完整`,
      assumptionBased: false,
    };
  }

  // ③ 无假设的硬判定:没有更多合规发布了,而窗口内从未达标。
  if (remaining <= 0) {
    return {
      kind: "impossible-hard",
      side: "NO",
      reason: `截止前已无更多合规发布,且 ${ratchet.readableCount} 期全部 < ${threshold}(最高 ${ratchet.maxValue}),NO 必然结算 $1`,
      assumptionBased: false,
    };
  }

  // ④ 有假设的强推定:连"整个高一级区域逐周全部恶化到顶"都够不到阈值。
  const bound = reachBound(latestCum, level, remaining);
  if (bound == null) {
    return { kind: "unreadable", side: "none", reason: "最近一期 cumulative 读不到,无法算物理上界", assumptionBased: false };
  }
  if (bound < threshold) {
    return {
      kind: "impossible-soft",
      side: "NO",
      reason: `剩 ${remaining} 期,物理上界 ${bound}%(= 当前 cum.d${Math.max(0, level - remaining)})< 阈值 ${threshold}%,` +
        `依赖"每期最多恶化一级"的经验假设`,
      assumptionBased: true,
    };
  }

  // ⑤ 统计性结论:够得到,但基线全程远低于阈值。给材料,不给确定性标签。
  //    "远低于" = 基线最高值不到阈值的一半。这个门槛是刻意粗的 —— 它只用来
  //    把"明显不像会发生"和"真的说不好"分开,精细化没有意义,因为最终
  //    仍然要人来估那个概率 q 并与保本准确率比。
  //    用 base 而不是 ratchet:见 ScanInput.baseline 的注释。
  if (base.count >= 4 && base.maxValue != null && base.maxValue < threshold / 2) {
    return {
      kind: "unlikely",
      side: "NO",
      reason: `剩 ${remaining} 期、物理上界 ${bound}% 够得到阈值 ${threshold}%,但 ${base.count} 期基线最高仅 ${base.maxValue}% ——` +
        `这是概率判断不是明牌,须自估 q 并与保本准确率比较`,
      assumptionBased: true,
    };
  }

  return {
    kind: "open",
    side: "none",
    reason: `剩 ${remaining} 期,窗口内最高 ${ratchet.maxValue}%、${base.count} 期基线最高 ${base.maxValue}%,物理上界 ${bound}% —— 未定`,
    assumptionBased: false,
  };
}

// ── 盘口与钱 ──────────────────────────────────────────────────

export interface BookLevel {
  price: number;
  size: number;
}

export interface EvResult {
  bestAsk: number | null;
  shares: number;
  costUsd: number;
  avgPrice: number | null;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  returnPct: number | null;
  ladder: string;
  breakEven: number | null;
}

/**
 * taker 费。**基数是股数,不是成交额** —— 08-08 Oregon 复盘里这个错让净利
 * 虚高 $0.92,而且巧合地等于 rebate 生效的数字,掩盖了一整轮。
 *   fee = rate × p × (1−p) × 股数
 * 尾价区 (1−p) 把实收压得很小,这正是 0.97+ 那些档"费很便宜但也没肉"的原因。
 */
export function takerFee(price: number, shares: number, rate: number): number {
  return rate * price * (1 - price) * shares;
}

/** 保本准确率 = ask + rate×ask×(1−ask)。买价之上还要覆盖费,故略高于 ask。 */
export function breakEvenAccuracy(ask: number, rate: number): number {
  return ask + rate * ask * (1 - ask);
}

/**
 * 把 ask 侧的 book 吃到 maxPrice 为止,算出这条腿的全部账。
 *
 * 只认逐档 `price × size`:Gamma 的 `liquidity` 字段与真实可成交深度经常差一个
 * 数量级(Virginia 实测 liquidity 579 vs ≤0.97 真实 book $527,Oregon 更夸张),
 * 拿它报 EV 会系统性高估容量。
 */
export function evFromBook(levels: BookLevel[], maxPrice: number, feeRate: number): EvResult {
  const sorted = [...levels]
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
  const inCap = sorted.filter((l) => l.price <= maxPrice);

  const shares = inCap.reduce((s, l) => s + l.size, 0);
  const costUsd = inCap.reduce((s, l) => s + l.price * l.size, 0);
  const feeUsd = inCap.reduce((s, l) => s + takerFee(l.price, l.size, feeRate), 0);
  const grossUsd = shares - costUsd; // 结算 $1/股
  const netUsd = grossUsd - feeUsd;
  const bestAsk = sorted[0]?.price ?? null;
  const avgPrice = shares > 0 ? costUsd / shares : null;

  return {
    bestAsk,
    shares: round(shares, 2),
    costUsd: round(costUsd, 2),
    avgPrice: avgPrice == null ? null : round(avgPrice, 4),
    grossUsd: round(grossUsd, 2),
    feeUsd: round(feeUsd, 2),
    netUsd: round(netUsd, 2),
    returnPct: costUsd > 0 ? round((netUsd / costUsd) * 100, 2) : null,
    ladder: sorted.slice(0, 12).map((l) => `${l.price}×${trimNum(l.size)}`).join(" "),
    breakEven: bestAsk == null ? null : round(breakEvenAccuracy(bestAsk, feeRate), 4),
  };
}

const round = (v: number, n: number): number => Math.round(v * 10 ** n) / 10 ** n;
const trimNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(round(v, 1)));

// ── 条款解析 ──────────────────────────────────────────────────

export interface ClauseInfo {
  stateAbbr: string | null;
  stateName: string | null;
  level: DroughtLevel | null;
  threshold: number | null;
  /** 条款写的口径:"Categorical Percent Area" ⟹ categorical。 */
  categorical: boolean | null;
  cutoffIso: string | null;
  ratchet: boolean;
  holdingDays: number | null;
  problems: string[];
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * 从 Gamma `description` 解析条款要素 —— **fail-closed**:任何一项解析不出来
 * 就把它记进 problems,由调用方降级为"人工读",绝不猜。
 *
 * 为什么不从 slug 或 question 推:两者都是展示文本,与条款可以不一致(项目
 * 已知的坑之一)。`description` 才是 UMA 结算时被引用的那段字。
 * 这个解析器的职责边界也很清楚:它把机器能确定的部分挑出来,
 * **拿不准的一律交回给人**,因为一个口径读错就会让方向反过来。
 */
export function parseClause(description: string | null | undefined): ClauseInfo {
  const problems: string[] = [];
  const d = description ?? "";
  if (!d) return { stateAbbr: null, stateName: null, level: null, threshold: null, categorical: null, cutoffIso: null, ratchet: false, holdingDays: null, problems: ["description 为空"] };

  // 等级:"D4 Exceptional Drought" / "D3 Extreme Drought"
  const lm = /\bD([0-4])\b/.exec(d);
  const level = lm ? (Number(lm[1]) as DroughtLevel) : null;
  if (level == null) problems.push("条款里找不到 D0–D4 等级");

  // 阈值:"is 1.00% or greater"
  const tm = /is\s+([0-9]+(?:\.[0-9]+)?)%\s+or\s+greater/i.exec(d);
  const threshold = tm ? Number(tm[1]) : null;
  if (threshold == null) problems.push('条款里找不到 "is X% or greater" 形式的阈值');

  // 口径:必须显式写明。缺失不猜 —— categorical 与 cumulative 在 D0–D3 上
  // 差着一整个累加,猜错方向就反了。
  const categorical = /"Categorical Percent Area"/i.test(d)
    ? true
    : /cumulative/i.test(d)
      ? false
      : null;
  if (categorical == null) problems.push("条款未写明 Categorical/Cumulative 口径");

  // 州:取 `"<州名>" means the entire State of` 这个句式,它是条款自己给的定义,
  // 比从 question 标题里猜州名可靠。
  let stateName: string | null = null;
  const sm = /"([A-Za-z .]+)"\s+means\s+the\s+entire\s+State\s+of/i.exec(d);
  if (sm) stateName = sm[1].trim();
  if (!stateName) {
    const hit = STATE_FIPS.find((s) => new RegExp(`\\bfor\\s+${s.name}\\b`, "i").test(d));
    if (hit) stateName = hit.name;
  }
  const st = stateName ? STATE_BY_NAME.get(stateName.toLowerCase()) ?? null : null;
  if (!st) problems.push(`条款里认不出州名${stateName ? `(拿到「${stateName}」但不在 FIPS 表里)` : ""}`);

  // 截止日:"through August 31, 2026"
  let cutoffIso: string | null = null;
  const cm = /through\s+([A-Za-z]+)\s+([0-9]{1,2}),\s*([0-9]{4})/i.exec(d);
  if (cm) {
    const mo = MONTHS[cm[1].toLowerCase()];
    if (mo) cutoffIso = `${cm[3]}-${mo}-${cm[2].padStart(2, "0")}`;
  }
  if (!cutoffIso) problems.push("条款里找不到 through <Month D, YYYY> 形式的截止日");

  // 棘轮语义:"in any weekly release"。没有它就不是棘轮盘,整套判据不适用。
  const ratchet = /in\s+any\s+weekly\s+release/i.test(d);
  if (!ratchet) problems.push('条款缺少 "in any weekly release" —— 不是棘轮式,本扫描器的判据不适用');

  const hm = /held\s+open\s+for\s+([0-9]+)\s+calendar\s+days/i.exec(d);
  const holdingDays = hm ? Number(hm[1]) : null;

  return {
    stateAbbr: st?.abbr ?? null,
    stateName: st?.name ?? stateName,
    level,
    threshold,
    categorical,
    cutoffIso,
    ratchet,
    holdingDays,
    problems,
  };
}

// ══ IO ════════════════════════════════════════════════════════

async function getJson<T>(url: string, ms = 25_000, tries = 3): Promise<T | null> {
  // 本机出口偶发 `CONNECT tunnel failed 503`(代理抖动,秒级自愈)。单次失败
  // 就返回 null 会让那个州静默变成 unreadable —— 与"源真的挂了"混为一谈,
  // 正是本脚本反复强调不能犯的错。重试三次是把口径失真挡在数据层。
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
      if (res.ok) return (await res.json()) as T;
    } catch {
      /* 落到下面的退避重试 */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}

const usFmt = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
};

function usdmUrl(fips: string, startIso: string, endIso: string, statisticsType: 1 | 2): string {
  return (
    `${USDM_API}?aoi=${aoiParam(fips)}` +
    `&startdate=${encodeURIComponent(usFmt(startIso))}&enddate=${encodeURIComponent(usFmt(endIso))}` +
    `&statisticsType=${statisticsType}`
  );
}

async function readSeries(fips: string, startIso: string, endIso: string): Promise<{ cat: UsdmRow[] | null; cum: UsdmRow[] | null }> {
  const [cat, cum] = await Promise.all([
    getJson<UsdmRow[]>(usdmUrl(fips, startIso, endIso, 2)),
    getJson<UsdmRow[]>(usdmUrl(fips, startIso, endIso, 1)),
  ]);
  return { cat, cum };
}

/** 把两个口径的多期返回,按 mapDate 对齐成逐期的三态判定。 */
export function alignSeries(
  cat: UsdmRow[] | null,
  cum: UsdmRow[] | null,
  opts: { level: DroughtLevel; threshold: number; abbr: string }
): SeriesPoint[] {
  const dates = new Set<string>();
  for (const r of cat ?? []) dates.add(String(r.mapDate ?? "").slice(0, 10));
  for (const r of cum ?? []) dates.add(String(r.mapDate ?? "").slice(0, 10));
  dates.delete("");
  return [...dates].sort().map((mapDate) => {
    const v = levelVerdict(cat, cum, { ...opts, mapDate });
    return { mapDate, kind: v.kind, value: v.value, reason: v.reason };
  });
}

interface GammaMarket {
  id?: string;
  slug?: string;
  question?: string;
  description?: string;
  conditionId?: string;
  questionID?: string;
  clobTokenIds?: string;
  outcomes?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  endDate?: string;
  startDate?: string;
  createdAt?: string;
  volume?: string | number;
  liquidity?: string | number;
  feeSchedule?: { rate?: number };
  orderMinSize?: number;
  orderPriceMinTickSize?: number;
}

/** Gamma `/markets` 的 `limit` 服务端硬顶。传 500 也只回 100(2026-08-08 实测)。 */
const GAMMA_PAGE = 100;
/** `/markets?offset=` 的可达上限。offset=3000 起返回错误对象而非数组(实测)。 */
const GAMMA_OFFSET_MAX = 2900;
/** Polymarket 的 `drought` tag id(2026-08-08 从 Oregon 盘的 event.tags 读出)。 */
const DROUGHT_TAG_ID = 105721;

/**
 * 找出全站所有 USDM 干旱型盘。
 *
 * ⚠ 2026-08-08 实测的三个 Gamma 行为,写错任何一个都会让本函数**静默返回空表**
 * (而空表看起来就像"全站没有这类盘"这个结论,是最坏的失败形态):
 *
 *   ① `limit` 被服务端硬截到 100。于是 `arr.length < limit ⟹ 取尽` 这个惯用
 *      终止条件在 limit>100 时**第一页就成立**,分页当场退出。终止条件必须
 *      按实际页长 GAMMA_PAGE 判,不能按请求的 limit 判。
 *   ② `?slug=<关键词>` 是**精确匹配**不是模糊匹配 —— `slug=drought` 返回 `[]`。
 *      整条关键词发现路径靠它是走不通的。
 *   ③ 真正的关键词入口是 `/public-search?q=`,返回的是 **events**(每个 event
 *      里挂着 markets 数组),结构与 `/markets` 不同,要拆一层。
 *
 * 两路并用:public-search 负责召回(四个关键词实测召回一致),分页负责兜底 ——
 * 后者只依赖分页本身,不会被平台侧搜索语义变更整条打掉。
 */
async function findDroughtMarkets(): Promise<GammaMarket[]> {
  const byId = new Map<string, GammaMarket>();
  const take = (m: GammaMarket, requireDesc: boolean): void => {
    const hay = `${m.slug ?? ""} ${m.question ?? ""} ${requireDesc ? m.description ?? "" : ""}`.toLowerCase();
    if (!hay.includes("drought")) return;
    const key = m.conditionId ?? m.slug ?? "";
    if (key && !byId.has(key)) byId.set(key, m);
  };

  // ── 主路 0:tag。这是平台**自己**的分类,比任何关键词都权威。──
  //   2026-08-08 实测 `tag_id=105721&closed=false` 恰好返回 OR + VA 两个 event,
  //   与 public-search 四种关键词、45 个 slug 变体探测三路独立核验一致。
  //   放在第一位是因为它不受命名习惯影响:将来出现 `will-utah-hit-d4-…` 这种
  //   关键词路照样命中(slug 含 drought),但若哪天平台改叫 "aridity",
  //   只有 tag 这条路还活着。
  const tagRes = await getJson<Array<{ closed?: boolean; markets?: GammaMarket[] }>>(
    `${GAMMA_API}/events?tag_id=${DROUGHT_TAG_ID}&closed=false&limit=${GAMMA_PAGE}`,
    30_000
  );
  if (Array.isArray(tagRes)) {
    for (const e of tagRes) {
      if (e.closed === true) continue;
      for (const m of e.markets ?? []) {
        if (m.closed !== true) take(m, true);
      }
    }
    emit({ kind: "discover", via: `tag:${DROUGHT_TAG_ID}`, events: tagRes.length, found: byId.size });
  } else {
    // tag id 是平台侧可变的。取不到时不静默 —— 否则"主路挂了"会伪装成"没有盘"。
    emit({ kind: "warn", msg: `tag_id=${DROUGHT_TAG_ID} 查询失败,退回关键词路(tag 可能已变更)` });
  }

  // ── 主路 1:public-search。多关键词是因为同族盘命名不统一,单一词会漏。──
  let searchOk = 0;
  for (const kw of ["drought", "exceptional drought", "drought monitor", "US Drought Monitor"]) {
    const res = await getJson<{ events?: Array<{ closed?: boolean; markets?: GammaMarket[] }> }>(
      `${GAMMA_API}/public-search?q=${encodeURIComponent(kw)}&limit_per_type=50`,
      30_000
    );
    if (!res || !Array.isArray(res.events)) continue;
    searchOk += 1;
    for (const e of res.events) {
      if (e.closed === true) continue;
      for (const m of e.markets ?? []) {
        if (m.closed === true) continue;
        take(m, true);
      }
    }
  }
  emit({ kind: "discover", via: "public-search", queriesOk: searchOk, found: byId.size });

  // ── 兜底:翻活跃盘。搜索路整条失效时这里仍能出结果。──
  let offset = 0;
  let pages = 0;
  let exhausted = false;
  while (offset <= GAMMA_OFFSET_MAX) {
    const arr = await getJson<GammaMarket[]>(`${GAMMA_API}/markets?closed=false&limit=${GAMMA_PAGE}&offset=${offset}`, 30_000);
    if (!Array.isArray(arr)) break; // offset 越界时回的是错误对象,不是空数组
    pages += 1;
    // 分页返回不带 description,只按 slug/question 筛 —— 命中后主流程会按
    // slug 单独拉一次拿全文。
    for (const m of arr) take(m, false);
    if (arr.length < GAMMA_PAGE) {
      exhausted = true;
      break;
    }
    offset += GAMMA_PAGE;
  }
  if (!exhausted) {
    // 没翻到底 ≠ 翻完了没有。这一行是为了让"0 条"永远不会被读成"全站没有"。
    emit({ kind: "warn", msg: `分页在 offset=${offset} 处停止(未取尽,Gamma offset 上限 ~${GAMMA_OFFSET_MAX}),兜底路存在覆盖盲区` });
  }
  emit({ kind: "discover", via: "pagination", pages, exhausted, totalFound: byId.size });

  // public-search 命中的 market 对象来自 events 内嵌,字段可能不全(尤其
  // description/clobTokenIds)。按 slug 逐个补拉一次全量字段。
  const full: GammaMarket[] = [];
  for (const m of byId.values()) {
    if (m.description && m.clobTokenIds) {
      full.push(m);
      continue;
    }
    const arr = await getJson<GammaMarket[]>(`${GAMMA_API}/markets?slug=${encodeURIComponent(m.slug ?? "")}`, 20_000);
    full.push(arr?.[0] ?? m);
  }
  return full;
}

async function readBook(tokenId: string): Promise<BookLevel[] | null> {
  const b = await getJson<{ asks?: Array<{ price: string; size: string }> }>(`${CLOB_API}/book?token_id=${tokenId}`, 15_000);
  if (b == null) return null;
  return (b.asks ?? []).map((a) => ({ price: Number(a.price), size: Number(a.size) }));
}

/** 小并发跑批 —— 源是 .edu 小站,打挂它等于把自己的数据源关掉。 */
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ══ 主流程 ════════════════════════════════════════════════════

interface StateSnapshot {
  abbr: string;
  fips: string;
  latestDate: string | null;
  cat: UsdmRow | null;
  cum: UsdmRow | null;
  series: { cat: UsdmRow[] | null; cum: UsdmRow[] | null };
  readable: boolean;
  note: string;
}

async function snapshotStates(startIso: string, endIso: string, abbrs: string[]): Promise<StateSnapshot[]> {
  const targets = STATE_FIPS.filter((s) => abbrs.length === 0 || abbrs.includes(s.abbr));
  return pool(targets, CONCURRENCY, async (s) => {
    const series = await readSeries(s.fips, startIso, endIso);
    const pickLatest = (rows: UsdmRow[] | null): UsdmRow | null => {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return [...rows].sort((a, b) => String(b.mapDate ?? "").localeCompare(String(a.mapDate ?? "")))[0] ?? null;
    };
    const cat = pickLatest(series.cat);
    const cum = pickLatest(series.cum);
    const readable = cat != null && cum != null;
    return {
      abbr: s.abbr,
      fips: s.fips,
      latestDate: cat ? String(cat.mapDate ?? "").slice(0, 10) : null,
      cat,
      cum,
      series,
      readable,
      note: readable ? "" : "空数组/请求失败 —— unreadable,不可读作 0",
    };
  });
}

async function main(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString().slice(0, 10);
  const startIso = new Date(now.getTime() - WEEKS * 7 * 86400_000).toISOString().slice(0, 10);

  emit({ kind: "start", nowIso, startIso, weeks: WEEKS, dataOnly: DATA_ONLY, noBook: NO_BOOK, maxPrice: MAX_PRICE, states: ONLY_STATES.length ? ONLY_STATES : "all" });

  // ── 数据面 ──
  const snaps = await snapshotStates(startIso, nowIso, ONLY_STATES);
  const unreadable = snaps.filter((s) => !s.readable).map((s) => s.abbr);
  emit({
    kind: "data-face",
    states: snaps.length,
    unreadable,
    latestDate: snaps.find((s) => s.latestDate)?.latestDate ?? null,
  });

  const dataFace = snaps.map((s) => ({
    abbr: s.abbr,
    fips: s.fips,
    mapDate: s.latestDate,
    readable: s.readable,
    cat: s.readable ? { d0: levelValue(s.cat, 0), d1: levelValue(s.cat, 1), d2: levelValue(s.cat, 2), d3: levelValue(s.cat, 3), d4: levelValue(s.cat, 4) } : null,
    cum: s.readable ? { d0: levelValue(s.cum, 0), d1: levelValue(s.cum, 1), d2: levelValue(s.cum, 2), d3: levelValue(s.cum, 3), d4: levelValue(s.cum, 4) } : null,
    crossCheck: s.readable ? crossCheck(s.cat, s.cum).ok : null,
    note: s.note,
  }));

  if (DATA_ONLY) {
    if (AS_JSON) console.log(JSON.stringify({ dataFace }, null, 2));
    else printDataFace(dataFace);
    emit({ kind: "done", mode: "data-only", states: dataFace.length });
    return;
  }

  // ── 盘面 ──
  const markets = await findDroughtMarkets();
  emit({ kind: "markets", found: markets.length, slugs: markets.map((m) => m.slug) });

  const snapByAbbr = new Map(snaps.map((s) => [s.abbr, s]));
  const results: Array<Record<string, unknown>> = [];

  for (const m of markets) {
    const clause = parseClause(m.description);
    const base = {
      slug: m.slug,
      question: m.question,
      conditionId: m.conditionId,
      endDate: m.endDate,
      closed: m.closed === true,
      acceptingOrders: m.acceptingOrders !== false,
      negRisk: m.negRisk === true,
      clause,
    };

    if (clause.problems.length > 0 || clause.stateAbbr == null || clause.level == null || clause.threshold == null || clause.cutoffIso == null) {
      results.push({ ...base, verdict: { kind: "unreadable", side: "none", reason: `条款解析未通过:${clause.problems.join(";")}`, assumptionBased: false }, needsHuman: true });
      continue;
    }
    // 口径必须是 categorical:本扫描器的 levelVerdict 取的是 categorical 那一列。
    // 条款若写 cumulative,取数列就得换,而不是"差不多一样"——D0–D3 差着整个累加。
    if (clause.categorical !== true) {
      results.push({ ...base, verdict: { kind: "unreadable", side: "none", reason: "条款口径非 Categorical Percent Area,本扫描器的取列口径不适用", assumptionBased: false }, needsHuman: true });
      continue;
    }

    let snap = snapByAbbr.get(clause.stateAbbr);
    if (!snap) {
      // ONLY_STATES 过滤掉了这个州,或该州不在表里 —— 按需补拉一次。
      const st = FIPS_BY_ABBR.get(clause.stateAbbr);
      if (!st) {
        results.push({ ...base, verdict: { kind: "unreadable", side: "none", reason: `${clause.stateAbbr} 不在 FIPS 表里`, assumptionBased: false }, needsHuman: true });
        continue;
      }
      if (ONLY_STATES.length > 0) continue; // 用户显式限定了州,跳过其他盘
      const series = await readSeries(st.fips, startIso, nowIso);
      snap = { abbr: st.abbr, fips: st.fips, latestDate: null, cat: null, cum: null, series, readable: false, note: "" };
    }

    // 窗口起点 = 条款生效日(market creation),不是本次拉数的起点。
    const created = (m.createdAt ?? m.startDate ?? "").slice(0, 10);
    const windowStart = created && created > startIso ? created : startIso;
    const points = alignSeries(snap.series.cat, snap.series.cum, {
      level: clause.level,
      threshold: clause.threshold,
      abbr: clause.stateAbbr,
    }).filter((p) => p.mapDate >= windowStart);

    // 两个统计量,两个用途:points 受条款窗口裁剪(棘轮只认它),
    // allPoints 是 --weeks 期的完整基线(概率判断用它)。见 ScanInput.baseline。
    const allPoints = alignSeries(snap.series.cat, snap.series.cum, {
      level: clause.level,
      threshold: clause.threshold,
      abbr: clause.stateAbbr,
    });
    const baselineRatchet = ratchetOverSeries(allPoints);
    const ratchet = ratchetOverSeries(points);
    const rem = remainingReleases(nowIso, clause.cutoffIso);
    const latestCum = snap.series.cum && snap.series.cum.length
      ? [...snap.series.cum].sort((a, b) => String(b.mapDate ?? "").localeCompare(String(a.mapDate ?? "")))[0]
      : null;

    const verdict = scanVerdict({
      ratchet,
      latestCum,
      level: clause.level,
      threshold: clause.threshold,
      remaining: rem.count,
      readableCount: ratchet.readableCount,
      baseline: { count: baselineRatchet.readableCount, maxValue: baselineRatchet.maxValue },
    });

    // ── 钱 ──
    let ev: EvResult | null = null;
    let leg: string | null = null;
    if (!NO_BOOK && verdict.side !== "none") {
      let outcomes: string[] = [];
      let tokenIds: string[] = [];
      try {
        outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
        tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
      } catch { /* 下面按缺失处理 */ }
      const idx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === verdict.side.toLowerCase());
      const tokenId = idx >= 0 ? tokenIds[idx] : undefined;
      if (tokenId) {
        leg = `${verdict.side}@idx${idx}`;
        const levels = await readBook(tokenId);
        if (levels) ev = evFromBook(levels, MAX_PRICE, m.feeSchedule?.rate ?? 0.05);
      }
    }

    results.push({
      ...base,
      windowStart,
      seriesCount: points.length,
      ratchet,
      baseline: { count: baselineRatchet.readableCount, maxValue: baselineRatchet.maxValue, weeks: WEEKS },
      remaining: rem,
      physicalBound: reachBound(latestCum, clause.level, rem.count),
      verdict,
      leg,
      ev,
      // 方向锁的第二把锁在扫描器里天然缺失(见文件头)。带 side 的结论一律
      // 标注为"需人工钉常量后由执行体下单",这行不是提示语,是流程的一部分。
      execution: verdict.side === "none" ? null : "报告 only —— 下单需人工把 tokenId/conditionId 钉进执行体",
    });
  }

  for (const r of results) emit({ kind: "market-verdict", ...r });

  const actionable = results.filter((r) => {
    const v = r.verdict as ScanVerdict;
    return v.kind === "triggered" || v.kind === "impossible-hard" || v.kind === "impossible-soft" || v.kind === "unlikely";
  });

  if (AS_JSON) {
    console.log(JSON.stringify({ dataFace, results }, null, 2));
  } else {
    printDataFace(dataFace);
    printMarkets(results);
  }

  const mailWorthy = actionable.filter((r) => {
    const v = r.verdict as ScanVerdict;
    const ev = r.ev as EvResult | null;
    if (v.kind === "triggered" || v.kind === "impossible-hard") return true;
    return (ev?.netUsd ?? 0) >= MIN_NET && MIN_NET > 0;
  });

  emit({ kind: "done", markets: results.length, actionable: actionable.length, mailWorthy: mailWorthy.length });

  if (MAIL && mailWorthy.length > 0) {
    const { sendMail } = await import("./mailer");
    const rows = mailWorthy.map((r) => {
      const v = r.verdict as ScanVerdict;
      const ev = r.ev as EvResult | null;
      return `<tr><td>${r.slug}</td><td><b>${v.kind}</b> → ${v.side}</td><td>${ev?.bestAsk ?? "-"}</td><td>$${ev?.netUsd ?? "-"}</td><td>${v.reason}</td></tr>`;
    }).join("");
    await sendMail({
      subject: `🌵 usdm-scan:${mailWorthy.length} 条可执行(${actionable.length} 条待看)`,
      html: `<table border=1 cellpadding=4><tr><th>slug</th><th>判定</th><th>ask</th><th>净利</th><th>理由</th></tr>${rows}</table>
             <p>⚠️ 扫描器只报告不下单。下单须人工把 tokenId/conditionId 钉进执行体并复核方向。</p>`,
      text: `usdm-scan: ${mailWorthy.length} actionable`,
    });
  }
}

function printDataFace(rows: Array<Record<string, unknown>>): void {
  const hits = rows.filter((r) => r.readable);
  console.log(`\n══ USDM 数据面(${hits.length}/${rows.length} 州可读)══`);
  console.log("州  mapDate      cat: d0    d1    d2    d3    d4    | cum.d4  校验");
  for (const r of rows) {
    if (!r.readable) {
      console.log(`${r.abbr}  —— unreadable(${r.note})`);
      continue;
    }
    const c = r.cat as Record<string, number | null>;
    const u = r.cum as Record<string, number | null>;
    const f = (v: number | null): string => (v == null ? "  —  " : v.toFixed(2).padStart(6));
    console.log(`${r.abbr}  ${r.mapDate}  ${f(c.d0)}${f(c.d1)}${f(c.d2)}${f(c.d3)}${f(c.d4)}  | ${f(u.d4)}  ${r.crossCheck ? "✓" : "✗"}`);
  }
  const d4hot = rows.filter((r) => r.readable && ((r.cat as Record<string, number | null>).d4 ?? 0) >= 1.0);
  console.log(`\nD4 ≥ 1.00% 的州:${d4hot.length ? d4hot.map((r) => `${r.abbr}(${(r.cat as Record<string, number>).d4})`).join(" ") : "无"}`);
}

function printMarkets(results: Array<Record<string, unknown>>): void {
  console.log(`\n══ 干旱盘判定(${results.length} 条)══`);
  for (const r of results) {
    const v = r.verdict as ScanVerdict;
    const ev = r.ev as EvResult | null;
    const mark = v.kind === "triggered" ? "🎯" : v.kind === "impossible-hard" ? "🔒" : v.kind === "impossible-soft" ? "🟡" : v.kind === "unlikely" ? "🔵" : v.kind === "unreadable" ? "❓" : "·";
    console.log(`\n${mark} ${r.slug}`);
    console.log(`   判定: ${v.kind} → ${v.side}${v.assumptionBased ? "(依赖经验假设)" : ""}`);
    console.log(`   理由: ${v.reason}`);
    if (r.remaining) console.log(`   剩余发布: ${(r.remaining as { count: number; dates: string[] }).count} 期 ${(r.remaining as { dates: string[] }).dates.join(",")}`);
    if (ev) {
      console.log(`   盘口(${r.leg}): ask ${ev.bestAsk} 保本 ${ev.breakEven} | ≤${MAX_PRICE} 深度 ${ev.shares} 股 / $${ev.costUsd} @${ev.avgPrice}`);
      console.log(`   钱: 毛 $${ev.grossUsd} − 费 $${ev.feeUsd} = 净 $${ev.netUsd}(${ev.returnPct}%)`);
      console.log(`   梯: ${ev.ladder}`);
    }
    if (r.needsHuman) console.log(`   ⚠ 需人工读条款`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    emit({ kind: "fatal", msg: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
