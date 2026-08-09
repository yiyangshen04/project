/**
 * usdm-scan 判据回归(2026-08-08)。
 *
 * 这个扫描器把 oregon-sniper 的单盘判据泛化到 50 州 × D0–D4,泛化过程里有
 * **四处会静默给出错误明牌**的写法,每一处都只能靠离线断言钉住:
 *
 *   ① `aoi` 少了前导零 —— AL/AK/AZ/AR/CA/CO/CT 七个州全部返回 `[]` + HTTP 200。
 *      不报错,只是七个州从结果里消失。
 *   ② 跨口径校验照抄 D4 那条 `cat.dK === cum.dK` —— 对 D0–D3 恒不成立
 *      (cumulative 是"该级及以上"的累计),会把正常数据全判成 unreadable。
 *   ③ 空数组读成 0 —— 于是每一条 "reach D4" 盘都变成 impossible。一张全是
 *      明牌的表,而且全错。
 *   ④ 把"物理上界够不到"(经验假设)与"已无更多发布"(数学事实)混为一谈 ——
 *      把一个概率押注包装成无风险套利。2026-08-08 的 Virginia 正好落在这条
 *      分界线上,所以它在下面有一条专门的断言。
 *
 * 全部离线:纯函数,无 fs/网络。运行:npx tsx --test tests/usdmScan.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATE_FIPS,
  aoiParam,
  levelValue,
  crossCheck,
  levelVerdict,
  ratchetOverSeries,
  remainingReleases,
  reachBound,
  scanVerdict,
  takerFee,
  breakEvenAccuracy,
  evFromBook,
  parseClause,
  alignSeries,
  type UsdmRow,
  type SeriesPoint,
} from "../scripts/usdm-scan";

// ── fixtures:2026-08-08 实测响应的逐字缩样 ──────────────────────

/** Virginia 2026-08-04,categorical(statisticsType=2)。实测原值。 */
const VA_CAT: UsdmRow = {
  mapDate: "2026-08-04T00:00:00",
  stateAbbreviation: "VA",
  none: 10.71, d0: 22.08, d1: 42.37, d2: 20.65, d3: 4.19, d4: 0.0,
  statisticFormatID: 2,
};
/** Virginia 2026-08-04,cumulative(statisticsType=1)。实测原值。 */
const VA_CUM: UsdmRow = {
  mapDate: "2026-08-04T00:00:00",
  stateAbbreviation: "VA",
  none: 10.71, d0: 89.29, d1: 67.21, d2: 24.84, d3: 4.19, d4: 0.0,
  statisticFormatID: 1,
};
/** Oregon 2026-08-04,categorical。实测原值(d4 = 2.15 是那笔实弹的依据)。 */
const OR_CAT: UsdmRow = {
  mapDate: "2026-08-04T00:00:00",
  stateAbbreviation: "OR",
  none: 1.52, d0: 7.5, d1: 26.26, d2: 39.96, d3: 22.61, d4: 2.15,
  statisticFormatID: 2,
};
const OR_CUM: UsdmRow = {
  mapDate: "2026-08-04T00:00:00",
  stateAbbreviation: "OR",
  none: 1.52, d0: 98.48, d1: 90.98, d2: 64.72, d3: 24.76, d4: 2.15,
  statisticFormatID: 1,
};

/** Virginia 盘 2026-08-08 实测 description 的逐字节选(判据全在这几句里)。 */
const VA_CLAUSE = `This market will resolve "Yes" if the D4 Exceptional Drought value shown in the official U.S. Drought Monitor's weekly "Categorical Percent Area" statistics table for Virginia published by the National Drought Mitigation Center at https://droughtmonitor.unl.edu/DmData/DataTables.aspx?dregion,4 is 1.00% or greater in any weekly release published from market creation through August 31, 2026, 11:59:59 PM ET. Otherwise, this market will resolve "No". D4 Exceptional Drought is defined as described at https://droughtmonitor.unl.edu/About/AbouttheData.aspx.

"Virginia" means the entire State of Virginia as recognized under U.S. law.

Upon a qualifying release, the market will be held open for 7 calendar days from its publication date before finalizing, to allow for NDMC corrections.`;

// ══ ① aoi 前导零 ══════════════════════════════════════════════

test("aoiParam:一位数 FIPS 必须补前导零(否则该州静默返回空数组)", () => {
  // 实测:aoi=1 → [] + HTTP 200;aoi=01 → Alabama。这不是格式洁癖。
  assert.equal(aoiParam(1), "01");
  assert.equal(aoiParam("1"), "01");
  assert.equal(aoiParam(6), "06");
  assert.equal(aoiParam("06"), "06");
  assert.equal(aoiParam(41), "41");
  assert.equal(aoiParam("41"), "41");
});

test("FIPS 表:七个一位数州都以零填充形式存储", () => {
  // 存字符串而不是 number,是为了让"忘记 padStart"这件事没有发生的余地。
  for (const abbr of ["AL", "AK", "AZ", "AR", "CA", "CO", "CT"]) {
    const s = STATE_FIPS.find((x) => x.abbr === abbr);
    assert.ok(s, `${abbr} 应在表里`);
    assert.equal(s.fips.length, 2, `${abbr} 的 fips 应是两位`);
    assert.equal(s.fips[0], "0", `${abbr} 的 fips 应有前导零`);
  }
  assert.equal(STATE_FIPS.find((x) => x.abbr === "OR")?.fips, "41");
  assert.equal(STATE_FIPS.find((x) => x.abbr === "VA")?.fips, "51");
});

test("FIPS 表:无重复 abbr、无重复 fips", () => {
  assert.equal(new Set(STATE_FIPS.map((s) => s.abbr)).size, STATE_FIPS.length);
  assert.equal(new Set(STATE_FIPS.map((s) => s.fips)).size, STATE_FIPS.length);
});

// ══ ② 跨口径恒等式(泛化时最容易写错的一处)══════════════════════

test("crossCheck:D4 两口径恒等(oregon-sniper 那条断言的来源)", () => {
  const xc = crossCheck(VA_CAT, VA_CUM);
  const d4 = xc.pairs.find((p) => p.level === 4);
  assert.equal(d4?.fromCategorical, 0);
  assert.equal(d4?.cumulative, 0);
  const orXc = crossCheck(OR_CAT, OR_CUM);
  assert.equal(orXc.pairs.find((p) => p.level === 4)?.fromCategorical, 2.15);
  assert.equal(orXc.pairs.find((p) => p.level === 4)?.cumulative, 2.15);
});

test("crossCheck:D0–D3 用的是累加公式,不是相等 —— 真实 VA 数据必须通过", () => {
  // cat.d0 = 22.08 而 cum.d0 = 89.29。照抄 D4 那条 `cat.dK === cum.dK` 的写法
  // 会把这组完全正常的实测数据判成"两口径打架 ⟹ unreadable",于是整个 D0–D3
  // 家族的盘一条都扫不出来。
  const xc = crossCheck(VA_CAT, VA_CUM);
  assert.equal(xc.ok, true, `真实数据应通过校验,却报:${xc.problems.join(";")}`);
  // 五个两位小数相加的浮点尾数(89.28999999999999)正是 crossCheck 里那条
  // 0.02 容差存在的理由 —— 断言本身也不能用严格相等。
  const near = (a: number | null, b: number): void => {
    assert.ok(a != null && Math.abs(a - b) < 1e-9, `期望 ≈${b},实际 ${a}`);
  };
  near(xc.pairs.find((p) => p.level === 0)?.cumulative ?? null, 89.29);
  near(xc.pairs.find((p) => p.level === 0)?.fromCategorical ?? null, 89.29);
  near(xc.pairs.find((p) => p.level === 3)?.fromCategorical ?? null, 4.19);
});

test("crossCheck:Oregon 实测数据同样通过", () => {
  const xc = crossCheck(OR_CAT, OR_CUM);
  assert.equal(xc.ok, true, xc.problems.join(";"));
});

test("crossCheck:真不一致(读到了不同期次)必须被抓出来", () => {
  const bad = { ...VA_CUM, d2: 99.9 };
  const xc = crossCheck(VA_CAT, bad);
  assert.equal(xc.ok, false);
  assert.ok(xc.problems.some((p) => p.includes("D2")));
});

test("crossCheck:容差吸收两位小数舍入,但不吸收真实偏差", () => {
  assert.equal(crossCheck(VA_CAT, { ...VA_CUM, d1: 67.22 }).ok, true); // 0.01 舍入
  assert.equal(crossCheck(VA_CAT, { ...VA_CUM, d1: 67.5 }).ok, false); // 0.29 真偏差
});

// ══ ③ 空数组绝不读成 0 ═════════════════════════════════════════

test("levelVerdict:空数组必须是 unreadable,绝不是 below", () => {
  // 这是整个文件最重要的断言。判成 below ⟹ 每一条 reach-D4 盘都变成
  // "从未达标 + 快到期 ⟹ impossible ⟹ 买 NO",一张全是明牌的表,而且全错。
  const v = levelVerdict([], [], { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" });
  assert.equal(v.kind, "unreadable");
  assert.notEqual(v.kind, "below");
  assert.equal(v.value, null);
  assert.match(v.reason, /空数组/);
});

test("levelVerdict:请求失败(null)也是 unreadable", () => {
  assert.equal(levelVerdict(null, [VA_CUM], { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" }).kind, "unreadable");
  assert.equal(levelVerdict([VA_CAT], null, { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" }).kind, "unreadable");
});

test("levelVerdict:aoi 指向别的州 → unreadable(不是拿那个州的数字当答案)", () => {
  const v = levelVerdict([OR_CAT], [OR_CUM], { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" });
  assert.equal(v.kind, "unreadable");
  assert.match(v.reason, /stateAbbreviation/);
});

test("levelVerdict:mapDate 对不上 → unreadable(不是拿别期数字当答案)", () => {
  const v = levelVerdict([VA_CAT], [VA_CUM], { level: 4, threshold: 1.0, mapDate: "2026-07-28", abbr: "VA" });
  assert.equal(v.kind, "unreadable");
  assert.match(v.reason, /mapDate/);
});

test("levelVerdict:字段非数值 → unreadable", () => {
  const v = levelVerdict(
    [{ ...VA_CAT, d4: "n/a" }],
    [{ ...VA_CUM, d4: "n/a" }],
    { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" }
  );
  assert.equal(v.kind, "unreadable");
});

test("levelVerdict:holds / below 的正常两态", () => {
  const or = levelVerdict([OR_CAT], [OR_CUM], { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "OR" });
  assert.equal(or.kind, "holds");
  assert.equal(or.value, 2.15);

  const va = levelVerdict([VA_CAT], [VA_CUM], { level: 4, threshold: 1.0, mapDate: "2026-08-04", abbr: "VA" });
  assert.equal(va.kind, "below");
  assert.equal(va.value, 0);
});

test("levelVerdict:D3 这一级也能正确判(泛化的直接验证)", () => {
  // VA D3 = 4.19。阈值 4.0 应 holds、阈值 5.0 应 below —— 若跨口径校验写错,
  // 这两条都会退化成 unreadable。
  assert.equal(levelVerdict([VA_CAT], [VA_CUM], { level: 3, threshold: 4.0, mapDate: "2026-08-04", abbr: "VA" }).kind, "holds");
  assert.equal(levelVerdict([VA_CAT], [VA_CUM], { level: 3, threshold: 5.0, mapDate: "2026-08-04", abbr: "VA" }).kind, "below");
});

test("levelValue:非数值一律 null,绝不回落成 0", () => {
  assert.equal(levelValue({ d4: "abc" }, 4), null);
  assert.equal(levelValue(null, 4), null);
  assert.equal(levelValue({ d4: 0 }, 4), 0); // 真实的 0 仍是 0
});

// ══ 棘轮:任一期达标即锁 ═══════════════════════════════════════

const pt = (mapDate: string, kind: SeriesPoint["kind"], value: number | null): SeriesPoint =>
  ({ mapDate, kind, value, reason: "" });

test("ratchet:窗口内任一期达标即触发,且记的是**首次**那一期", () => {
  const r = ratchetOverSeries([
    pt("2026-07-21", "below", 0.2),
    pt("2026-07-28", "holds", 1.4),
    pt("2026-08-04", "below", 0.9), // 回落无效 —— 棘轮已锁
  ]);
  assert.equal(r.triggered, true);
  assert.equal(r.firstHitDate, "2026-07-28");
  assert.equal(r.firstHitValue, 1.4);
  assert.equal(r.maxValue, 1.4);
});

test("ratchet:乱序输入也按日期排序后取首次", () => {
  const r = ratchetOverSeries([pt("2026-08-04", "holds", 3), pt("2026-07-21", "holds", 1.1)]);
  assert.equal(r.firstHitDate, "2026-07-21");
});

test("ratchet:unreadable 期次既不算达标也不算未达标,只计数", () => {
  // 把它算进 readableCount 会让"从未达标"这个结论看起来比实际更完整,
  // scanVerdict 因此拿不到"结论不完整"的信号。
  const r = ratchetOverSeries([pt("2026-07-21", "below", 0), pt("2026-07-28", "unreadable", null), pt("2026-08-04", "below", 0)]);
  assert.equal(r.triggered, false);
  assert.equal(r.unreadableCount, 1);
  assert.equal(r.readableCount, 2);
});

// ══ 剩余发布次数 ═════════════════════════════════════════════

test("remainingReleases:2026-08-08 → 08-31 之间还剩 3 个周四", () => {
  // 08-13 / 08-20 / 08-27。08-31 是周一,不是发布日。这条数字直接决定
  // Virginia 的物理上界该取 cum.d1 还是 cum.d3 —— 差三级。
  const r = remainingReleases("2026-08-08", "2026-08-31");
  assert.equal(r.count, 3);
  assert.deepEqual(r.dates, ["2026-08-13", "2026-08-20", "2026-08-27"]);
});

test("remainingReleases:from 当天是周四时不计入(那期已发布)", () => {
  const r = remainingReleases("2026-08-06", "2026-08-31"); // 08-06 是周四
  assert.equal(r.dates.includes("2026-08-06"), false);
  assert.equal(r.count, 3);
});

test("remainingReleases:cutoff 当天是周四则计入", () => {
  const r = remainingReleases("2026-08-08", "2026-08-13");
  assert.deepEqual(r.dates, ["2026-08-13"]);
});

test("remainingReleases:窗口已过 → 0", () => {
  assert.equal(remainingReleases("2026-09-01", "2026-08-31").count, 0);
});

// ══ ④ 物理上界:经验假设,与数学事实分开 ═══════════════════════

test("reachBound:N 期后的上界 = cum.d(level−N)", () => {
  // VA cum: d0=89.29 d1=67.21 d2=24.84 d3=4.19 d4=0
  assert.equal(reachBound(VA_CUM, 4, 1), 4.19);   // 1 期后 ≤ 现在的 D3 及以上
  assert.equal(reachBound(VA_CUM, 4, 2), 24.84);
  assert.equal(reachBound(VA_CUM, 4, 3), 67.21);
  assert.equal(reachBound(VA_CUM, 4, 4), 89.29);
  assert.equal(reachBound(VA_CUM, 4, 5), 100);     // 越界 → 无约束
});

test("reachBound:没有更多发布时上界为 0(值不会再变)", () => {
  assert.equal(reachBound(VA_CUM, 4, 0), 0);
});

test("reachBound:cum 读不到 → null,绝不回落成 0", () => {
  assert.equal(reachBound(null, 4, 1), null);
  assert.equal(reachBound({ d3: "x" }, 4, 1), null);
});

// ══ 综合裁决:六态与优先级 ═════════════════════════════════════

const RATCHET_CLEAN = { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0, unreadableCount: 0, readableCount: 8 };

test("scanVerdict:triggered 压过一切(棘轮已锁,后续数据无关)", () => {
  const v = scanVerdict({
    ratchet: { triggered: true, firstHitDate: "2026-08-04", firstHitValue: 2.15, maxValue: 2.15, unreadableCount: 3, readableCount: 5 },
    latestCum: OR_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 5,
  });
  assert.equal(v.kind, "triggered");
  assert.equal(v.side, "YES");
  assert.equal(v.assumptionBased, false);
});

test("scanVerdict:窗口内有读不到的期次 → unreadable,不给 NO 结论", () => {
  const v = scanVerdict({
    ratchet: { ...RATCHET_CLEAN, unreadableCount: 1, readableCount: 7 },
    latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 0, readableCount: 7,
  });
  assert.equal(v.kind, "unreadable");
  assert.equal(v.side, "none");
});

test("scanVerdict:剩 0 期且从未达标 → impossible-hard,且**不依赖任何假设**", () => {
  const v = scanVerdict({ ratchet: RATCHET_CLEAN, latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 0, readableCount: 8 });
  assert.equal(v.kind, "impossible-hard");
  assert.equal(v.side, "NO");
  assert.equal(v.assumptionBased, false);
});

test("scanVerdict:物理上界够不到 → impossible-soft,且**必须标注依赖假设**", () => {
  // 剩 1 期、上界 = cum.d3 = 0.5 < 阈值 1.0
  const cum = { ...VA_CUM, d3: 0.5, d4: 0 };
  const v = scanVerdict({ ratchet: RATCHET_CLEAN, latestCum: cum, level: 4, threshold: 1.0, remaining: 1, readableCount: 8 });
  assert.equal(v.kind, "impossible-soft");
  assert.equal(v.side, "NO");
  assert.equal(v.assumptionBased, true, "soft 结论必须自报依赖经验假设");
});

test("scanVerdict:hard 优先于 soft(无假设的结论压过有假设的)", () => {
  const cum = { ...VA_CUM, d3: 0.5 };
  const v = scanVerdict({ ratchet: RATCHET_CLEAN, latestCum: cum, level: 4, threshold: 1.0, remaining: 0, readableCount: 8 });
  assert.equal(v.kind, "impossible-hard");
});

test("baseline:统计维度用长基线,棘轮维度用条款窗口 —— 两者必须分开", () => {
  // Virginia 盘 2026-07-21 创建 ⟹ 条款窗口内只有 3 期,撑不起统计结论。
  // 但"VA 会不会冒出 D4"是关于该州基线的问题,12 期能回答。
  // 不分开的后果:每一条新创建的盘都被推回 open,unlikely 这一档形同虚设。
  const windowRatchet = { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0, unreadableCount: 0, readableCount: 3 };
  const withoutBaseline = scanVerdict({
    ratchet: windowRatchet, latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 3,
  });
  assert.equal(withoutBaseline.kind, "open", "无基线时样本不足,应保守回落到 open");

  const withBaseline = scanVerdict({
    ratchet: windowRatchet, latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 3,
    baseline: { count: 12, maxValue: 0 },
  });
  assert.equal(withBaseline.kind, "unlikely");
  assert.match(withBaseline.reason, /12 期基线/);
});

test("★ baseline 绝不参与棘轮判定 —— 窗口外的达标不算数", () => {
  // 条款只认 "from market creation" 之后的发布。若拿基线序列去判棘轮,
  // 一次盘创建前的历史达标就会被读成"已触发 ⟹ 买 YES",方向直接反掉,
  // 而那条腿会结算 $0。基线只能影响 unlikely,不能影响 triggered。
  const v = scanVerdict({
    ratchet: { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0, unreadableCount: 0, readableCount: 3 },
    latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 3,
    baseline: { count: 12, maxValue: 9.9 }, // 基线里有远超阈值的历史
  });
  assert.notEqual(v.kind, "triggered", "窗口外的达标绝不能触发棘轮");
  assert.notEqual(v.side, "YES");
});

test("★ Virginia 2026-08-08 的真实情形必须判成 unlikely,不是 impossible", () => {
  // 这条是本文件的诚实性断言。VA:8 期 d4 全 0、D3 从 32.52 单调改善到 4.19、
  // NO 腿 ask 0.95 —— 看起来像明牌。但剩 3 期、物理上界 = cum.d1 = 67.21%,
  // **够得到** 1.00% 的阈值。判成 impossible 就是把一个 5% 回报的概率押注
  // 包装成无风险套利卖给自己。
  const v = scanVerdict({
    ratchet: { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0, unreadableCount: 0, readableCount: 8 },
    latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 8,
  });
  assert.equal(v.kind, "unlikely");
  assert.notEqual(v.kind, "impossible-hard");
  assert.notEqual(v.kind, "impossible-soft");
  assert.equal(v.side, "NO");
  assert.equal(v.assumptionBased, true);
  assert.match(v.reason, /概率判断/);
});

test("scanVerdict:历史太短(<4 期)不给 unlikely —— 样本不足撑不起统计结论", () => {
  const v = scanVerdict({
    ratchet: { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0, unreadableCount: 0, readableCount: 3 },
    latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 3,
  });
  assert.equal(v.kind, "open");
});

test("scanVerdict:历史最高值接近阈值 → open,不是 unlikely", () => {
  const v = scanVerdict({
    ratchet: { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: 0.8, unreadableCount: 0, readableCount: 8 },
    latestCum: VA_CUM, level: 4, threshold: 1.0, remaining: 3, readableCount: 8,
  });
  assert.equal(v.kind, "open");
  assert.equal(v.side, "none");
});

test("scanVerdict:一个可读期次都没有 → unreadable", () => {
  const v = scanVerdict({
    ratchet: { triggered: false, firstHitDate: null, firstHitValue: null, maxValue: null, unreadableCount: 8, readableCount: 0 },
    latestCum: null, level: 4, threshold: 1.0, remaining: 3, readableCount: 0,
  });
  assert.equal(v.kind, "unreadable");
});

// ══ 钱:费的基数是股数 ═══════════════════════════════════════

test("takerFee:基数是股数不是成交额(08-08 Oregon 复盘踩过这个错)", () => {
  // 100 股 @0.72:fee = 0.05 × 0.72 × 0.28 × 100 = $1.008
  // 若误按成交额($72)算 = 0.05 × 0.72 × 0.28 × 72 = $0.726 —— 少算 28%。
  assert.equal(Math.round(takerFee(0.72, 100, 0.05) * 1000) / 1000, 1.008);
  assert.notEqual(Math.round(takerFee(0.72, 72, 0.05) * 1000) / 1000, 1.008);
});

test("takerFee:尾价区被 (1−p) 压小", () => {
  assert.ok(takerFee(0.99, 100, 0.05) < takerFee(0.72, 100, 0.05));
});

test("breakEvenAccuracy:与 oregon-sniper 头注的实测对照表逐位一致", () => {
  const r = (v: number): number => Math.round(v * 10000) / 10000;
  assert.equal(r(breakEvenAccuracy(0.72, 0.05)), 0.7301);
  // ⚠ oregon-sniper 头注原写 0.8359,是手算笔误 —— 正确值 0.8371
  //   (0.83 + 0.05×0.83×0.17 = 0.83 + 0.0070555)。头注已一并订正。
  //   不影响任何已做决策:实际置信度 97–99% 远高于两者,0.83 那档该吃仍该吃。
  assert.equal(r(breakEvenAccuracy(0.83, 0.05)), 0.8371);
  assert.equal(r(breakEvenAccuracy(0.9, 0.05)), 0.9045);
  assert.equal(r(breakEvenAccuracy(0.95, 0.05)), 0.9524);
});

test("evFromBook:Virginia NO 腿 ≤0.97 的实测账目", () => {
  // 2026-08-08 实测 NO 腿 ask 侧:0.95×319.53 0.96×198.58 0.97×34.74 0.98×404.84 0.99×3635
  const ev = evFromBook(
    [
      { price: 0.95, size: 319.53 },
      { price: 0.96, size: 198.58 },
      { price: 0.97, size: 34.74 },
      { price: 0.98, size: 404.84 },
      { price: 0.99, size: 3635 },
    ],
    0.97,
    0.05
  );
  assert.equal(ev.bestAsk, 0.95);
  assert.equal(ev.shares, 552.85);
  assert.equal(ev.costUsd, 527.89);
  assert.equal(ev.grossUsd, 24.96);
  // 0.98/0.99 那 4039 股必须被帽挡在外面 —— 它们才是"看起来深度很大"的来源。
  assert.ok(ev.costUsd < 600, "0.98/0.99 档不该被计入");
  assert.ok(ev.netUsd > 0 && ev.netUsd < ev.grossUsd);
  assert.equal(ev.breakEven, 0.9524);
});

test("evFromBook:空 book 不炸,返回全零", () => {
  const ev = evFromBook([], 0.97, 0.05);
  assert.equal(ev.bestAsk, null);
  assert.equal(ev.shares, 0);
  assert.equal(ev.returnPct, null);
});

test("evFromBook:非法档位被过滤(size≤0 / 非数)", () => {
  const ev = evFromBook(
    [{ price: 0.9, size: 0 }, { price: Number.NaN, size: 10 }, { price: 0.9, size: 100 }],
    0.97,
    0.05
  );
  assert.equal(ev.shares, 100);
});

// ══ 条款解析:fail-closed ══════════════════════════════════════

test("parseClause:Virginia 实测条款的六个要素全部解析正确", () => {
  const c = parseClause(VA_CLAUSE);
  assert.equal(c.stateAbbr, "VA");
  assert.equal(c.level, 4);
  assert.equal(c.threshold, 1.0);
  assert.equal(c.categorical, true);
  assert.equal(c.cutoffIso, "2026-08-31");
  assert.equal(c.ratchet, true);
  assert.equal(c.holdingDays, 7);
  assert.deepEqual(c.problems, []);
});

test("parseClause:缺棘轮语义 → 记 problem(本扫描器的判据不适用)", () => {
  const c = parseClause(VA_CLAUSE.replace("in any weekly release", "in the final weekly release"));
  assert.equal(c.ratchet, false);
  assert.ok(c.problems.some((p) => p.includes("棘轮")));
});

test("parseClause:口径未写明 → null + problem,绝不默认 categorical", () => {
  // D0–D3 上 categorical 与 cumulative 差着整个累加,猜错方向就反了。
  const c = parseClause(VA_CLAUSE.replace('"Categorical Percent Area"', '"Percent Area"'));
  assert.equal(c.categorical, null);
  assert.ok(c.problems.some((p) => p.includes("口径")));
});

test("parseClause:认不出州 → problem(不猜)", () => {
  const c = parseClause(VA_CLAUSE.replace(/Virginia/g, "Freedonia"));
  assert.equal(c.stateAbbr, null);
  assert.ok(c.problems.some((p) => p.includes("州名")));
});

test("parseClause:空 description → 全 null + problem", () => {
  const c = parseClause("");
  assert.equal(c.level, null);
  assert.equal(c.threshold, null);
  assert.ok(c.problems.length > 0);
});

test("parseClause:阈值不是 1.00 也能读(D3 型盘的横扩前提)", () => {
  const c = parseClause(VA_CLAUSE.replace("D4 Exceptional", "D3 Extreme").replace("is 1.00% or greater", "is 25.50% or greater"));
  assert.equal(c.level, 3);
  assert.equal(c.threshold, 25.5);
});

// ══ 序列对齐 ═════════════════════════════════════════════════

test("alignSeries:两口径按 mapDate 对齐,缺一边的期次记 unreadable", () => {
  const cat = [VA_CAT, { ...VA_CAT, mapDate: "2026-07-28T00:00:00", d3: 8.45, d4: 0 }];
  const cum = [VA_CUM]; // 07-28 只有 categorical
  const pts = alignSeries(cat, cum, { level: 4, threshold: 1.0, abbr: "VA" });
  assert.equal(pts.length, 2);
  assert.equal(pts.find((p) => p.mapDate === "2026-08-04")?.kind, "below");
  assert.equal(pts.find((p) => p.mapDate === "2026-07-28")?.kind, "unreadable");
});

test("alignSeries:两边都空 → 空序列(而不是一串 below)", () => {
  assert.deepEqual(alignSeries([], [], { level: 4, threshold: 1.0, abbr: "VA" }), []);
});
