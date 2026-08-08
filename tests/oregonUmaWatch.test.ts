/**
 * oregon-uma-watch 判定回归(2026-08-08)。
 *
 * 为什么这个文件必须存在:这个脚本的全部价值在于"该不该发信、发哪一封",
 * 而它的错误形态都是**静默**的 —— 跑起来永远不报错,只是在关键时刻不发信。
 * 三处一旦写错就等于监控不存在,且无法靠"跑一次看看"发现:
 *
 *   · 把 RPC 读不到(null)判成"无提案":探针失效期间我们会以为一切正常,
 *     而真实情况可能是有人已提 No 且 liveness 正在流逝。
 *   · 给 proposed_wrong 加上去重键:错误提案的 liveness 只有 2h,cron 15
 *     分钟一轮本该发 8 封,去重后只发 1 封 —— 那一封若被漏看就是 −$437。
 *   · 判定顺序调换:已结算/争议/提案三者的优先级错位,会让终态被报成中间态。
 *
 * 时刻分支同样只能离线断言(要等到 08-13 才能"实测"就来不及了)。
 *
 * 全部离线:纯函数,无 fs/网络。运行:npx tsx --test tests/oregonUmaWatch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  umaVerdict,
  mailSubject,
  priceLabel,
  humanRemaining,
  FINALIZE_AT_MS,
  SELF_PROPOSE_MS,
  PUBLICATION_MS,
  type ChainRead,
} from "../scripts/oregon-uma-watch";

const ZERO = "0x0000000000000000000000000000000000000000";
const P_YES = 10n ** 18n;
const P_NO = 0n;
const P_TOO_EARLY = 2n ** 255n - 1n;

const read = (over: Partial<ChainRead> = {}): ChainRead => ({
  resolved: false,
  paused: false,
  settled: false,
  proposer: ZERO,
  disputer: ZERO,
  proposedPrice: 0n,
  resolvedPrice: 0n,
  expirationTime: 0n,
  ...over,
});

/** 各时刻的代表时点 */
const T_HOLDING = new Date(PUBLICATION_MS + 86_400_000); // 08-07,holding 期内
const T_WINDOW = new Date(FINALIZE_AT_MS + 3_600_000); // 08-13 13:30Z
const T_OVERDUE = new Date(SELF_PROPOSE_MS + 3_600_000); // 08-14 13:30Z

// ── 三态:读不到 ≠ 无提案(本文件最重要的一条)────────────────────

test("读不到(null)必须是 unreadable,绝不是 waiting/window_open", () => {
  for (const now of [T_HOLDING, T_WINDOW, T_OVERDUE]) {
    const v = umaVerdict(null, now);
    assert.equal(v.state, "unreadable", `now=${now.toISOString()}`);
    assert.equal(v.notify, true, "探针失效必须发信,静默等于监控不存在");
  }
});

test("unreadable 按小时节流(自愈状态,不该只提醒一次)", () => {
  const a = umaVerdict(null, new Date(Date.UTC(2026, 7, 10, 5, 10)));
  const b = umaVerdict(null, new Date(Date.UTC(2026, 7, 10, 5, 55)));
  const c = umaVerdict(null, new Date(Date.UTC(2026, 7, 10, 6, 5)));
  assert.equal(a.dedupeKey, b.dedupeKey, "同一小时内应去重");
  assert.notEqual(a.dedupeKey, c.dedupeKey, "跨小时应重新发信");
});

// ── 错误提案:必须每轮都发(不可去重)──────────────────────────

test("proposed_wrong 的 dedupeKey 必须是 null —— liveness 只有 2h,漏一封 = 全部本金", () => {
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_NO }), T_WINDOW);
  assert.equal(v.state, "proposed_wrong");
  assert.equal(v.dedupeKey, null, "此态刻意不去重,加上去重键就是把监控关掉");
  assert.equal(v.severity, "crit");
  assert.equal(v.notify, true);
});

test("提案 Too Early 也算 proposed_wrong(非 Yes 一律要 dispute)", () => {
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_TOO_EARLY }), T_OVERDUE);
  assert.equal(v.state, "proposed_wrong");
  assert.equal(v.dedupeKey, null);
});

test("提案 Yes 是好消息:info + 去重一次即可", () => {
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_YES }), T_WINDOW);
  assert.equal(v.state, "proposed_yes");
  assert.equal(v.severity, "info");
  assert.equal(v.dedupeKey, "proposed-yes");
});

test("proposed_wrong 正文必须带上 liveness 到期时刻(那是唯一的行动截止线)", () => {
  const exp = BigInt(Math.floor(T_WINDOW.getTime() / 1000) + 7200);
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_NO, expirationTime: exp }), T_WINDOW);
  assert.match(v.detail, /liveness 到期 = 2026-08-13 15:30Z/);
  assert.match(v.detail, /还剩 2 小时 0 分/);
});

// ── 判定优先级(顺序错位会把终态报成中间态)────────────────────

test("已结算优先于 disputed:曾被争议但已 settle,应报 settled 而非 disputed", () => {
  const v = umaVerdict(
    read({ settled: true, resolved: true, proposer: "0xaa", disputer: "0xbb", proposedPrice: P_YES, resolvedPrice: P_YES }),
    T_OVERDUE
  );
  assert.equal(v.state, "settled_yes");
});

test("disputed 优先于 proposed:有争议时不该报成「已有人提案 Yes」", () => {
  const v = umaVerdict(read({ proposer: "0xaa", disputer: "0xbb", proposedPrice: P_YES }), T_WINDOW);
  assert.equal(v.state, "disputed");
  assert.equal(v.severity, "crit");
});

test("paused 优先于一切:人工裁定路径绕开 UMA,必须最先被看见", () => {
  const v = umaVerdict(read({ paused: true, proposer: "0xaa", proposedPrice: P_YES }), T_WINDOW);
  assert.equal(v.state, "paused");
  assert.equal(v.severity, "crit");
});

test("settle 后 resolvedPrice 尚未写入时,以 proposedPrice 为准(两者有一轮时间差)", () => {
  const v = umaVerdict(read({ settled: true, proposer: "0xaa", proposedPrice: P_YES, resolvedPrice: 0n }), T_OVERDUE);
  assert.equal(v.state, "settled_yes", "不能因 resolvedPrice 还是 0 就误报成结算为 No");
});

test("结算成非 Yes 是 crit,不是 info", () => {
  const v = umaVerdict(read({ settled: true, resolved: true, proposedPrice: P_NO, resolvedPrice: P_NO }), T_OVERDUE);
  assert.equal(v.state, "settled_other");
  assert.equal(v.severity, "crit");
});

// ── 时刻分支(等到 08-13 才实测就来不及了)──────────────────────

test("holding 期内无提案 = waiting,且**刻意不发信**", () => {
  const v = umaVerdict(read(), T_HOLDING);
  assert.equal(v.state, "waiting");
  assert.equal(v.notify, false, "窗口未开时提醒只会诱发一次必然被 dispute 的提案");
});

test("holding 期满前一毫秒仍是 waiting", () => {
  const v = umaVerdict(read(), new Date(FINALIZE_AT_MS - 1));
  assert.equal(v.state, "waiting");
  assert.equal(v.notify, false);
});

test("holding 期满那一刻起 = window_open,开始发信", () => {
  const v = umaVerdict(read(), new Date(FINALIZE_AT_MS));
  assert.equal(v.state, "window_open");
  assert.equal(v.notify, true);
  assert.equal(v.dedupeKey, "window-open", "只发一封");
});

test("window_open 正文要给出自提时点,以及 USDC.e 的前置准备", () => {
  const v = umaVerdict(read(), T_WINDOW);
  assert.match(v.detail, /2026-08-14 12:30Z/);
  assert.match(v.detail, /USDC\.e/);
});

test("超过自提时点仍无提案 = overdue,按天节流", () => {
  const a = umaVerdict(read(), T_OVERDUE);
  assert.equal(a.state, "overdue");
  assert.equal(a.severity, "warn");
  const b = umaVerdict(read(), new Date(T_OVERDUE.getTime() + 3 * 3_600_000));
  assert.equal(a.dedupeKey, b.dedupeKey, "同一天内去重");
  const c = umaVerdict(read(), new Date(T_OVERDUE.getTime() + 25 * 3_600_000));
  assert.notEqual(a.dedupeKey, c.dedupeKey, "跨天重发,避免拖成永久静默");
});

test("三个时刻常量的相对关系不可被改乱", () => {
  assert.equal(FINALIZE_AT_MS - PUBLICATION_MS, 7 * 86_400_000, "holding 期是条款写死的 7 天");
  assert.equal(SELF_PROPOSE_MS - FINALIZE_AT_MS, 86_400_000, "自提时点比合规时点多留 1 天缓冲");
  assert.equal(new Date(PUBLICATION_MS).toISOString(), "2026-08-06T12:30:00.000Z", "USDM 周四 08:30 ET 发布");
});

// ── 展示函数 ────────────────────────────────────────────────────

test("priceLabel 覆盖 UMA 四个约定取值,未知值原样回显不猜", () => {
  assert.equal(priceLabel(P_YES), "Yes");
  assert.equal(priceLabel(P_NO), "No");
  assert.equal(priceLabel(5n * 10n ** 17n), "50/50(无法判定)");
  assert.equal(priceLabel(P_TOO_EARLY), "Too Early(尚不该定)");
  assert.match(priceLabel(12345n), /未知取值 12345/);
});

// ── 演习邮件必须能与真事件区分(2026-08-08 实测教训)──────────────

test("演习标记必须出现在**主题行**,不能只在正文", () => {
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_YES }), T_WINDOW);
  const drill = mailSubject(v, "proposed_yes");
  const real = mailSubject(v, null);
  assert.match(drill, /演习/, "告警邮件的实际阅读方式是只看标题");
  assert.match(drill, /非真实事件/);
  assert.doesNotMatch(real, /演习/, "真事件的主题不得被演习标记污染");
  assert.notEqual(drill, real, "演习与真事件的主题逐字相同 = 演习比不发更糟");
});

test("演习标记在最前面(邮件列表里标题常被截断)", () => {
  const v = umaVerdict(null, T_WINDOW);
  assert.ok(mailSubject(v, "unreadable").startsWith("【演习"), "必须是主题的第一个字符");
});

test("crit 态的演习也必须带标记 —— 最吓人的那封最需要区分", () => {
  const v = umaVerdict(read({ proposer: "0xaa", proposedPrice: P_NO }), T_WINDOW);
  assert.match(mailSubject(v, "proposed_wrong"), /演习/);
});

test("humanRemaining 区分未到期与已过期", () => {
  assert.equal(humanRemaining(7_200_000), "还剩 2 小时 0 分");
  assert.equal(humanRemaining(600_000), "还剩 10 分");
  assert.match(humanRemaining(-3_600_000), /^已过期 1 小时 0 分$/);
});
