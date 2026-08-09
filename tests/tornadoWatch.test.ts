/**
 * tornado-watch 的离线闸门回归。
 *
 * 全部断言都不碰网络 —— 判据抽成了纯函数才有断言接缝。
 * 最重要的三条(改代码后先看它们有没有响):
 *   ① 读不到 ≠ 未达标:historyCount=0 → unreadable,不是 below;
 *   ② remainderStats 单边缺失必须丢整年,否则 minRemainder 被压到 0、下界判据失效;
 *   ③ 费的基数是股数,不是成交额。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNceiValue,
  isPreliminary,
  readSeries,
  remainderStats,
  tornadoVerdict,
  evFromBook,
  identityCheck,
} from "../scripts/tornado-watch";

const BASE = {
  threshold: 1250,
  dayKey: "20260808",
  hourKey: "2026080814",
  everCleared: false,
};

// ══ parseNceiValue ══════════════════════════════════════════════

test('parseNceiValue:"1141*" 剥掉 preliminary 星号', () => {
  assert.equal(parseNceiValue("1141*"), 1141);
  assert.equal(isPreliminary("1141*"), true);
});

test("parseNceiValue:纯数字与数值型都读得出", () => {
  assert.equal(parseNceiValue(1223), 1223);
  assert.equal(parseNceiValue("1223"), 1223);
  assert.equal(isPreliminary(1223), false);
});

test("parseNceiValue:带千分位逗号也读得出", () => {
  assert.equal(parseNceiValue("1,805"), 1805);
});

test("parseNceiValue:0 是合法计数,必须返回 0 而不是 null", () => {
  // 这条是三态纪律的接缝:若 0 被当成"读不到",一个真实的零龙卷月会被误报 unreadable;
  // 反过来若 null 被当成 0,端点故障会被读成"该月零龙卷"、把下界算低。
  assert.equal(parseNceiValue(0), 0);
  assert.equal(parseNceiValue("0"), 0);
});

test("parseNceiValue:非数 / 空 / null 一律 null,绝不返回 0", () => {
  for (const bad of ["", "  ", "N/A", "*", null, undefined, {}, [], NaN, Infinity]) {
    assert.equal(parseNceiValue(bad), null, `${JSON.stringify(bad)} 应为 null`);
  }
});

// ══ readSeries ══════════════════════════════════════════════════

const YTD7 = {
  "202207": 927,
  "202307": 1078,
  "202407": 1404,
  "202507": 1223,
  // 注意:故意混入一个不同月档的键,readSeries 必须忽略它
  "202606": "1141*",
};

test("readSeries:只取同月档的键,不同月档必须被忽略", () => {
  const r = readSeries(YTD7, 2026, 7);
  assert.equal(r.currentValue, null, "202607 不存在 ⟹ 本年值应为 null");
  assert.equal(r.historyCount, 4, "只有 4 个 07 档历史键");
  assert.deepEqual(Object.keys(r.history).map(Number).sort(), [2022, 2023, 2024, 2025]);
});

test("readSeries:本年键存在时读出值与 preliminary 标记", () => {
  const r = readSeries({ ...YTD7, "202607": "1274*" }, 2026, 7);
  assert.equal(r.currentValue, 1274);
  assert.equal(r.currentPreliminary, true);
  assert.equal(r.historyCount, 4, "本年键不计入 historyCount");
});

test("readSeries:空对象 / null → historyCount 0(锚点失效的信号)", () => {
  for (const bad of [null, {}, undefined as never]) {
    const r = readSeries(bad as never, 2026, 7);
    assert.equal(r.currentValue, null);
    assert.equal(r.historyCount, 0);
  }
});

test("readSeries:非 YYYYMM 的键被忽略,不污染历史计数", () => {
  const r = readSeries({ foo: 1, "2026": 2, "20260": 3, "202507": 1223 }, 2026, 7);
  assert.equal(r.historyCount, 1);
});

// ══ remainderStats ══════════════════════════════════════════════

test("remainderStats:实测数据的剩余月贡献(2026-08-08 从 NCEI 拉到的真实数字)", () => {
  const ytd7 = { 2022: 927, 2023: 1078, 2024: 1404, 2025: 1223 };
  const full = { 2022: 1143, 2023: 1321, 2024: 1805, 2025: 1383 };
  const s = remainderStats(ytd7, full, 4, 2026);
  assert.equal(s.sampleYears, 4);
  assert.equal(s.fromYear, 2022);
  assert.equal(s.minRemainder, 160, "2025 的 Aug–Dec = 1383 − 1223 = 160,是四年最小");
  assert.equal(s.medianRemainder, (216 + 243) / 2, "2022=216 与 2023=243 的均值");
});

test("remainderStats:窗口必须真的截断 —— 这是判据的一部分,不是调参", () => {
  // 2026-08-08 首次实跑踩到的真事:NCEI 序列回溯到 1950 年,全量 76 年的
  // minRemainder = 49(来自 1950 年,那年全年才 201 个龙卷)。拿它当 2026 的下界
  // 会得出"1141 + 49 = 1190 < 1250 不过阈";而近 20 年最小是 210 ⟹ 1351 过阈。
  // 结论完全相反,所以窗口不能悄悄默认。
  const ytd = { 1950: 152, 2012: 728, 2024: 1191, 2025: 1133 };
  const full = { 1950: 201, 2012: 938, 2024: 1805, 2025: 1383 };
  const wide = remainderStats(ytd, full, 80, 2026);
  const narrow = remainderStats(ytd, full, 20, 2026);
  assert.equal(wide.minRemainder, 49, "全量窗口会把 1950 年的 49 算进来");
  assert.equal(narrow.minRemainder, 210, "近 20 年窗口里 2012 的 210 才是最小");
  assert.equal(narrow.fromYear, 2006);
  assert.ok(!narrow.perYear.some((p) => p.year === 1950), "1950 必须被窗口排除");
});

test("remainderStats:目标年自身不参与统计", () => {
  // 目标年没有 full(还没到年底),但即便端点给了值也不能拿自己算自己的下界。
  const s = remainderStats({ 2025: 1133, 2026: 1141 }, { 2025: 1383, 2026: 9999 }, 20, 2026);
  assert.equal(s.sampleYears, 1);
  assert.ok(!s.perYear.some((p) => p.year === 2026));
});

test("remainderStats:单边缺失的年份必须整年丢掉,不能当 remainder=0", () => {
  // 本文件第二重要的断言。若把缺 full 的年份算成 remainder=0,minRemainder 会变成 0,
  // 下界判据退化成"已印值 ≥ 阈值",整个 bound-clears 态失效。
  // 而这个错误在日志上只表现为一个偏小的数字,不会报错。
  const s = remainderStats({ 2023: 1078, 2024: 1404, 2025: 1223 }, { 2024: 1805, 2025: 1383 }, 20, 2026);
  assert.equal(s.sampleYears, 2, "2023 没有 full,必须被丢掉");
  assert.equal(s.minRemainder, 160);
  assert.ok(!s.perYear.some((p) => p.year === 2023), "2023 不该出现在配对明细里");
});

test("remainderStats:两边都空 → minRemainder null(而不是 0)", () => {
  const s = remainderStats({}, {}, 20, 2026);
  assert.equal(s.minRemainder, null);
  assert.equal(s.sampleYears, 0);
});

test("remainderStats:负 remainder(数据错位)不进统计但留在明细里备查", () => {
  const s = remainderStats({ 2024: 1900 }, { 2024: 1805 }, 20, 2026);
  assert.equal(s.minRemainder, null, "唯一样本是负的 ⟹ 无有效样本");
  assert.equal(s.perYear.length, 1, "但要留痕,否则端点变更会被静默吞掉");
  assert.equal(s.perYear[0]!.remainder, -95);
});

// ══ tornadoVerdict ══════════════════════════════════════════════

const REM = { minRemainder: 160, medianRemainder: 243, sampleYears: 4, fromYear: 2022, perYear: [] };

test("tornadoVerdict:historyCount=0 → unreadable,绝不是 below", () => {
  // 最重要的一条。把"端点坏了"读成"未达标"会让判据静默失效;
  // 读成"已达标"更糟。两个方向都必须走 unreadable。
  const v = tornadoVerdict({
    latestMonth: 7, latestValue: null, latestPreliminary: false,
    historyCount: 0, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "unreadable");
  assert.equal(v.notify, true, "端点失效必须告警");
  assert.equal(v.lowerBound, null);
});

test("tornadoVerdict:一个月都没探到 → unreadable", () => {
  const v = tornadoVerdict({
    latestMonth: null, latestValue: null, latestPreliminary: false,
    historyCount: 70, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "unreadable");
});

test("tornadoVerdict:历史锚点在但本年未发布 → waiting,且刻意静默", () => {
  const v = tornadoVerdict({
    latestMonth: 7, latestValue: null, latestPreliminary: false,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "waiting");
  assert.equal(v.notify, false, "绝大多数轮次都是这个态,发信就是 288 封/天噪音");
});

test("tornadoVerdict:已印值本身过阈 → printed-clears(最强档)", () => {
  const v = tornadoVerdict({
    latestMonth: 7, latestValue: 1274, latestPreliminary: true,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "printed-clears");
  assert.equal(v.lowerBound, 1274);
  assert.equal(v.notify, true);
  assert.equal(v.dedupeKey, "printed-clears", "终态永久去重,不带日期后缀");
  assert.match(v.detail, /不是条款棘轮/, "必须点明它不是 Oregon 那种条款锁定");
});

test("tornadoVerdict:下界过阈但已印值未过 → bound-clears,且必须自称 unlikely", () => {
  // 2026-08-08 的真实情形:已印 Jan–Jun = 1141,剩余月历史最小 160 ⟹ 下界 1301。
  const v = tornadoVerdict({
    latestMonth: 6, latestValue: 1141, latestPreliminary: true,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "bound-clears");
  assert.equal(v.lowerBound, 1301);
  assert.equal(v.notify, true);
  assert.match(v.detail, /unlikely,不是 locked/, "包装成明牌是本项目反复踩的坑,断言钉住它");
  assert.match(v.detail, /占资约 5 个月/, "必须提醒占资周期,否则回报率会被高估");
  assert.equal(v.dedupeKey, "bound-clears", "必须永久去重 —— 按天会在 5 个月里发约 150 封同样的信");
});

test("tornadoVerdict:曾过阈后跌回 → bound-lost,必须打破静默", () => {
  // 这是最容易被漏掉的失败态:NCEI 一次向下修订让状态从 bound-clears 退回 below,
  // 而 below 是静默态 ⟹ 判据已经失效但没有任何人会知道。everCleared 这一位就是为它设的。
  const v = tornadoVerdict({
    latestMonth: 6, latestValue: 900, latestPreliminary: true, historyCount: 20,
    remainder: REM, ...BASE, everCleared: true,
  });
  assert.equal(v.state, "bound-lost");
  assert.equal(v.severity, "crit");
  assert.equal(v.notify, true, "坏消息必须发信,不能沿用 below 的静默");
  assert.equal(v.lowerBound, 1060);
  assert.match(v.detail, /直接影响在险金额/);
});

test("tornadoVerdict:从未过阈时的 below 保持静默(与 bound-lost 分开)", () => {
  const v = tornadoVerdict({
    latestMonth: 6, latestValue: 900, latestPreliminary: true, historyCount: 20,
    remainder: REM, ...BASE, everCleared: false,
  });
  assert.equal(v.state, "below");
  assert.equal(v.notify, false);
});

test("tornadoVerdict:everCleared 不影响过阈时的判定", () => {
  // everCleared 只用于区分两种 below,不该渗进 bound-clears/printed-clears 的判定。
  for (const ever of [true, false]) {
    const bc = tornadoVerdict({
      latestMonth: 6, latestValue: 1141, latestPreliminary: true, historyCount: 20,
      remainder: REM, ...BASE, everCleared: ever,
    });
    assert.equal(bc.state, "bound-clears");
    const pc = tornadoVerdict({
      latestMonth: 7, latestValue: 1300, latestPreliminary: false, historyCount: 20,
      remainder: REM, ...BASE, everCleared: ever,
    });
    assert.equal(pc.state, "printed-clears");
  }
});

test("tornadoVerdict:printed-clears 与 bound-clears 必须是两个态,不能合并", () => {
  // 两者推翻条件不同:前者只怕下修,后者还多一条"剩余月贡献跌破历史最小"。
  const printed = tornadoVerdict({
    latestMonth: 7, latestValue: 1300, latestPreliminary: false,
    historyCount: 4, remainder: REM, ...BASE,
  });
  const bound = tornadoVerdict({
    latestMonth: 7, latestValue: 1200, latestPreliminary: false,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(printed.state, "printed-clears");
  assert.equal(bound.state, "bound-clears");
  assert.notEqual(printed.state, bound.state);
});

test("tornadoVerdict:下界不足 → below,静默继续等", () => {
  const v = tornadoVerdict({
    latestMonth: 4, latestValue: 900, latestPreliminary: true,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "below");
  assert.equal(v.lowerBound, 1060);
  assert.equal(v.notify, false);
});

test("tornadoVerdict:恰好等于阈值算过阈(≥ 不是 >)", () => {
  const v = tornadoVerdict({
    latestMonth: 7, latestValue: 1090, latestPreliminary: false,
    historyCount: 4, remainder: REM, ...BASE,
  });
  assert.equal(v.state, "bound-clears", "1090 + 160 = 1250,恰好等于阈值");
  assert.equal(v.lowerBound, 1250);
});

test("tornadoVerdict:剩余月样本不足时不做任何锁定推断", () => {
  const v = tornadoVerdict({
    latestMonth: 7, latestValue: 1200, latestPreliminary: false, historyCount: 4,
    remainder: { minRemainder: null, medianRemainder: null, sampleYears: 0, fromYear: 2006, perYear: [] },
    ...BASE,
  });
  assert.equal(v.state, "below", "算不出下界就不能声称锁定");
  assert.equal(v.lowerBound, null);
});

test("tornadoVerdict:bound-clears 必须把窗口敏感性写进正文", () => {
  // 判据对窗口敏感(1141+49 不过阈 / 1141+210 过阈),这个事实必须在告警里可见,
  // 不能被一个默认窗口藏起来 —— 否则读信的人会以为下界是唯一确定的。
  const v = tornadoVerdict({
    latestMonth: 6, latestValue: 1141, latestPreliminary: true, historyCount: 76,
    remainder: { minRemainder: 210, medianRemainder: 357, sampleYears: 20, fromYear: 2006, perYear: [] },
    sensitivity: { 5: 250, 10: 250, 20: 210, 40: 169, 80: 49 },
    ...BASE,
  });
  assert.equal(v.state, "bound-clears");
  assert.equal(v.lowerBound, 1351);
  assert.match(v.detail, /窗口敏感性/);
  assert.match(v.detail, /近 80 年:最小贡献 49 ⟹ 下界 1190 ✗ 不过阈/, "必须把不过阈的那个窗口也照实列出");
  assert.match(v.detail, /近 20 年:最小贡献 210 ⟹ 下界 1351 ✓ 过阈/);
  assert.match(v.detail, /量纲错误/, "必须解释为什么不用全量窗口");
});

test("tornadoVerdict:无 sensitivity 时正文不出现敏感性小节(不编造)", () => {
  const v = tornadoVerdict({
    latestMonth: 6, latestValue: 1141, latestPreliminary: true, historyCount: 76,
    remainder: REM, ...BASE,
  });
  assert.equal(v.state, "bound-clears");
  assert.ok(!v.detail.includes("窗口敏感性"));
});

// ══ evFromBook ══════════════════════════════════════════════════

test("evFromBook:费的基数是股数不是成交额(Oregon 复盘踩过)", () => {
  const ev = evFromBook([{ price: 0.9, size: 100 }], 0.97, 0.05, 0);
  // 正确:0.05 × 0.9 × 0.1 × 100 股 = 0.45
  // 错误(基数取成交额):0.05 × 0.9 × 0.1 × 90 美元 = 0.405
  assert.equal(Number(ev.feeUsd.toFixed(6)), 0.45);
  assert.equal(ev.shares, 100);
  assert.equal(Number(ev.costUsd.toFixed(6)), 90);
  assert.equal(Number(ev.grossUsd.toFixed(6)), 10);
  assert.equal(Number(ev.netUsd.toFixed(6)), 9.55);
});

test("evFromBook:超过追高闸的档位被跳过", () => {
  const ev = evFromBook(
    [{ price: 0.89, size: 100 }, { price: 0.98, size: 500 }],
    0.97, 0.05, 0
  );
  assert.equal(ev.shares, 100, "0.98 那档在帽外");
  assert.equal(ev.ladder, "0.89×100");
});

test("evFromBook:低于 orderMinSize 的残档被滤掉(实测有 0.08 股的档)", () => {
  const ev = evFromBook(
    [{ price: 0.91, size: 0.08 }, { price: 0.95, size: 10 }],
    0.97, 0.05, 5
  );
  assert.equal(ev.shares, 10, "0.08 股 < orderMinSize 5,不可独立成交");
  assert.equal(Number(ev.avgPrice.toFixed(4)), 0.95);
});

test("evFromBook:保本准确率 = avg + rate×avg×(1−avg)", () => {
  const ev = evFromBook([{ price: 0.89, size: 100 }], 0.97, 0.05, 0);
  assert.equal(Number(ev.breakEven.toFixed(6)), Number((0.89 + 0.05 * 0.89 * 0.11).toFixed(6)));
});

test("evFromBook:feeRate=0 时费为 0(实测存在 feesEnabled=false 的盘)", () => {
  const ev = evFromBook([{ price: 0.89, size: 100 }], 0.97, 0, 0);
  assert.equal(ev.feeUsd, 0);
  assert.equal(Number(ev.netUsd.toFixed(6)), 11);
});

test("evFromBook:空 book 不炸,返回全零", () => {
  const ev = evFromBook([], 0.97, 0.05, 5);
  assert.equal(ev.shares, 0);
  assert.equal(ev.netUsd, 0);
  assert.equal(ev.returnPct, 0);
  assert.equal(ev.breakEven, 0);
});

test("evFromBook:非法档位(size≤0 / 非数)被过滤", () => {
  const ev = evFromBook(
    [
      { price: 0.9, size: 0 },
      { price: 0.9, size: -5 },
      { price: NaN, size: 10 },
      { price: 0.9, size: NaN },
      { price: 0.9, size: 50 },
    ],
    0.97, 0.05, 0
  );
  assert.equal(ev.shares, 50);
});

// ══ identityCheck(方向双向锁)═══════════════════════════════════

const GOOD_DESC =
  "This market will resolve according to the number of tornadoes recorded in the United States in 2026, " +
  "based on the monthly counts published on the National Centers for Environmental Information U.S. Tornadoes " +
  "Time Series page (see: https://www.ncei.noaa.gov/access/monitoring/tornadoes/time-series). " +
  "If the value published after this scheduled release time is labeled preliminary, it will still determine resolution, " +
  "and the market will resolve independently of any subsequent revisions. " +
  "The market will not resolve based on any preliminary values published before the scheduled release time.";

const GOOD = {
  id: "1428393",
  conditionId: "0x8573d651a82cbec45f07062b45f3d57a53767d25f71cee58bc3b8cceba591d4d",
  outcomes: '["Yes", "No"]',
  clobTokenIds:
    '["3274128037323255693352700223516152318165926806162369715072005689501999219702", "34688099504460699399295502360185969353859811669232873247071276139368724328549"]',
  closed: false,
  acceptingOrders: true,
  description: GOOD_DESC,
};

test("identityCheck:2026-08-08 实测的真实字段全部通过", () => {
  const r = identityCheck(GOOD);
  assert.equal(r.ok, true, `不该有 problem:${r.problems.join(" / ")}`);
});

test("identityCheck:outcomes 顺序被调换必须拒绝(方向锁的核心)", () => {
  // 平台侧一次顺序变更就能让"取 Yes 腿"静默取到 No。这条盘 YES 必然 $1 / NO 必然 $0,
  // 方向错不是少赚,是本金归零。下标指向 Yes 之外,还要求 tokenId 逐字相等。
  const r = identityCheck({
    ...GOOD,
    outcomes: '["No", "Yes"]',
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("tokenId 不等于写死常量")));
});

test("identityCheck:conditionId 不符必须拒绝", () => {
  const r = identityCheck({ ...GOOD, conditionId: "0xdeadbeef" });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("conditionId")));
});

test("identityCheck:已 closed / 停止接单必须拒绝", () => {
  // 上一轮把三条已结算盘误诊为"活着但被下架的冷盘",归因完全反了。
  assert.equal(identityCheck({ ...GOOD, closed: true }).ok, false);
  assert.equal(identityCheck({ ...GOOD, acceptingOrders: false }).ok, false);
  assert.equal(identityCheck({ ...GOOD, umaResolutionStatus: "resolved" }).ok, false);
});

test("identityCheck:proposed 不算终局(不该因此拒绝)", () => {
  // 已结算盘的 umaResolutionStatuses 会停在 ["proposed"],但 proposed 本身
  // 不等于已终局 —— 判活性要看 closed/acceptingOrders,不能看 proposed。
  const r = identityCheck({ ...GOOD, umaResolutionStatus: "proposed" });
  assert.equal(r.ok, true);
});

test("identityCheck:条款三句关键句任一缺失都要报(条款被改过则判据可能不适用)", () => {
  const r1 = identityCheck({ ...GOOD, description: GOOD_DESC.replace("ncei.noaa.gov/access/monitoring/tornadoes/time-series", "example.com") });
  assert.ok(r1.problems.some((p) => p.includes("结算源 NCEI")));

  const r2 = identityCheck({ ...GOOD, description: GOOD_DESC.replace("it will still determine resolution", "it will be ignored") });
  assert.ok(r2.problems.some((p) => p.includes("preliminary governs")));

  const r3 = identityCheck({ ...GOOD, description: GOOD_DESC.replace("not resolve based on any preliminary values published before", "xxx") });
  assert.ok(r3.problems.some((p) => p.includes("发布前 preliminary 不算")));
});

test("identityCheck:market 缺失 / 字段非法不炸", () => {
  assert.equal(identityCheck(null).ok, false);
  assert.equal(identityCheck(undefined).ok, false);
  assert.equal(identityCheck({ ...GOOD, outcomes: "not json" }).ok, false);
  assert.equal(identityCheck({ ...GOOD, clobTokenIds: "{" }).ok, false);
});
