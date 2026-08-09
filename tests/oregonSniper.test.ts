/**
 * oregon-sniper 闸门回归(2026-08-08)。
 *
 * 为什么这个文件必须存在:这条盘的"答案"来自一个外部数字(USDM Oregon D4),
 * 而下单方向由 Gamma 的两个平行数组下标决定。两处各有一个 −100% 级的写法:
 *   · 把 USDM 的**空数组 + HTTP 200**(该 API 已知的静默失败形态,传字母州码
 *     就会这样)读成"d4 = 0 ⟹ 触发被撤回",于是一次参数错/网络抖动就把全系统
 *     的 kill-switch 落下;反过来读成"仍达标"则 R1 闸完全不存在。
 *   · 把 outcomes/clobTokenIds 的下标对齐当成可信,买到 No 腿 —— 这条盘 YES
 *     必然结算 $1、NO 必然结算 $0,方向错不是少赚,是本金归零。
 * 这两处的正确行为无法靠"跑一次看看"确认(需要构造 API 的异常返回),只能
 * 用离线断言钉住。
 *
 * 全部离线:纯函数,无 fs/网络。运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usdmVerdict,
  identityCheck,
  execCapPins,
  fireDecision,
  isExhausted,
  priceCapFor,
  parseTiers,
  budgetForAsk,
  withRetry,
  transientDecision,
  type UsdmRow,
  type GammaMarket,
} from "../scripts/oregon-sniper";

// ── fixtures:2026-08-08 实测响应的逐字缩样 ──────────────────────

const row = (d4: number | string, fmt: 1 | 2, over: Partial<UsdmRow> = {}): UsdmRow => ({
  mapDate: "2026-08-04T00:00:00",
  stateAbbreviation: "OR",
  d4,
  statisticFormatID: fmt,
  ...over,
});

const CAT_OK = [row(2.15, 2)];
const CUM_OK = [row(2.15, 1)];

const DESC_OK =
  'This market will resolve "Yes" if the D4 Exceptional Drought value shown in the official U.S. Drought ' +
  'Monitor\'s weekly "Categorical Percent Area" statistics table for Oregon published by the National Drought ' +
  "Mitigation Center at https://droughtmonitor.unl.edu/DmData/DataTables.aspx?dregion,4 is 1.00% or greater " +
  "in any weekly release published from market creation through August 31, 2026, 11:59:59 PM ET. Otherwise, " +
  'this market will resolve "No".';

const YES_TOKEN = "44935700105237965955717992503068972172128092356886921170252269229765298541502";
const NO_TOKEN = "4104462894884354320274433680650587950051911999604418244402350274522720111556";

const MARKET_OK: GammaMarket = {
  id: "3085957",
  question: "Will Oregon reach D4 (Exceptional Drought) by August 31, 2026?",
  conditionId: "0xd0e66191853681730e4a0cfbf71b1ee9c73d8c222e2cb139bdd8147886b38075",
  questionID: "0x07c68043825c3f4331acf8f7b6971abb7064aa8345b32a93260a7fb8270fed37",
  clobTokenIds: JSON.stringify([YES_TOKEN, NO_TOKEN]),
  outcomes: JSON.stringify(["Yes", "No"]),
  closed: false,
  active: true,
  acceptingOrders: true,
  negRisk: false,
  description: DESC_OK,
};

// ── usdmVerdict:三态,重点在 revoked 与 unreadable 绝不可互串 ──────

test("holds:两口径 d4=2.15 一致且 ≥1.00", () => {
  const v = usdmVerdict(CAT_OK, CUM_OK);
  assert.equal(v.kind, "holds");
  assert.equal(v.d4, 2.15);
});

test("holds 的边界:恰好 1.00 达标(条款是「1.00% or greater」)", () => {
  assert.equal(usdmVerdict([row(1.0, 2)], [row(1.0, 1)]).kind, "holds");
});

test("revoked:明确读到 d4 < 1.00 —— 这是唯一该落 kill-switch 的状态", () => {
  const v = usdmVerdict([row(0.42, 2)], [row(0.42, 1)]);
  assert.equal(v.kind, "revoked");
  assert.equal(v.d4, 0.42);
});

test("revoked 的边界:0.99 不达标", () => {
  assert.equal(usdmVerdict([row(0.99, 2)], [row(0.99, 1)]).kind, "revoked");
});

test("空数组必须是 unreadable,绝不是 revoked", () => {
  // 这是本文件最重要的一条断言。USDM 传错 aoi(字母码而非 FIPS 41)会返回
  // `[]` 且 HTTP 200,与"该州无数据"完全不可区分。判成 revoked = 一次参数错
  // 就把全系统的交易停掉。
  assert.equal(usdmVerdict([], CUM_OK).kind, "unreadable");
  assert.equal(usdmVerdict(CAT_OK, []).kind, "unreadable");
  assert.equal(usdmVerdict([], []).kind, "unreadable");
});

test("请求失败(null)是 unreadable,不是 revoked", () => {
  assert.equal(usdmVerdict(null, CUM_OK).kind, "unreadable");
  assert.equal(usdmVerdict(CAT_OK, null).kind, "unreadable");
});

test("mapDate 不是触发那一期 → unreadable(不能拿下周的数据判这一期)", () => {
  // 棘轮条款下,08-11 那期即使 d4=0 也不推翻 08-04 的触发。闸门必须钉死在
  // 触发期上;拿到别的期次说明查询窗口错了,停火而不是下结论。
  const late = [row(0.0, 2, { mapDate: "2026-08-11T00:00:00" })];
  const v = usdmVerdict(late, [row(0.0, 1, { mapDate: "2026-08-11T00:00:00" })]);
  assert.equal(v.kind, "unreadable");
  assert.match(v.reason, /mapDate/);
});

test("两口径 d4 不一致 → unreadable(D4 最高级本应恒等)", () => {
  const v = usdmVerdict([row(2.15, 2)], [row(1.87, 1)]);
  assert.equal(v.kind, "unreadable");
  assert.match(v.reason, /不一致/);
});

test("州码不是 OR → unreadable(aoi 指向了别的州)", () => {
  const v = usdmVerdict([row(2.15, 2, { stateAbbreviation: "VA" })], CUM_OK);
  assert.equal(v.kind, "unreadable");
  assert.match(v.reason, /≠ OR/);
});

test("d4 字段非数值 → unreadable(不是当 0 处理)", () => {
  assert.equal(usdmVerdict([row("N/A", 2)], CUM_OK).kind, "unreadable");
  assert.equal(usdmVerdict([row(null as unknown as number, 2)], CUM_OK).kind, "unreadable");
});

test("d4 字符串数字仍可解析(API 曾以字符串返回数值字段)", () => {
  const v = usdmVerdict([row("2.15", 2)], [row("2.15", 1)]);
  assert.equal(v.kind, "holds");
  assert.equal(v.d4, 2.15);
});

// ── identityCheck:方向双向锁 ──────────────────────────────────

test("完整正确的市场通过校验", () => {
  const r = identityCheck(MARKET_OK);
  assert.equal(r.ok, true, r.problems.join(" | "));
});

test("outcomes 顺序反转但 tokenId 没跟着换 → 拒绝(方向锁的核心)", () => {
  // 平台若把 outcomes 改成 ["No","Yes"] 而 clobTokenIds 不变,"取 Yes 下标"
  // 这段代码会静默取到 NO 腿。逐字比对写死常量是唯一能挡住它的机制。
  const flipped = { ...MARKET_OK, outcomes: JSON.stringify(["No", "Yes"]) };
  const r = identityCheck(flipped);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /Yes 腿 tokenId 不符/);
});

test("clobTokenIds 换成别的 token → 拒绝", () => {
  const r = identityCheck({ ...MARKET_OK, clobTokenIds: JSON.stringify([NO_TOKEN, YES_TOKEN]) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /tokenId 不符/);
});

test("conditionId / questionID 任一不符即拒绝", () => {
  assert.equal(identityCheck({ ...MARKET_OK, conditionId: "0xdead" }).ok, false);
  assert.equal(identityCheck({ ...MARKET_OK, questionID: "0xdead" }).ok, false);
});

test("条款被改写(阈值句消失)→ 拒绝", () => {
  const r = identityCheck({ ...MARKET_OK, description: DESC_OK.replace("1.00% or greater", "5.00% or greater") });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /条款关键句缺失/);
});

test("条款棘轮语义句消失 → 拒绝", () => {
  // "any weekly release ... through August 31" 是棘轮性质的来源。改成"as of
  // August 31"这条盘就完全变了 —— 08-04 达标、08-25 回落就会结算 No。
  const r = identityCheck({
    ...MARKET_OK,
    description: DESC_OK.replace("in any weekly release published from market creation through August 31, 2026", "as of August 31, 2026"),
  });
  assert.equal(r.ok, false);
});

test("市场已 closed / 停止接单 → 拒绝启动", () => {
  assert.equal(identityCheck({ ...MARKET_OK, closed: true }).ok, false);
  assert.equal(identityCheck({ ...MARKET_OK, acceptingOrders: false }).ok, false);
});

test("市场取不到 → 拒绝(不是当成通过)", () => {
  assert.equal(identityCheck(null).ok, false);
  assert.equal(identityCheck(undefined).ok, false);
});

// ── execCapPins:日额度只抬不降 ────────────────────────────────

test("perToken/perEvent 一起钉到 budget(单钉 perToken 会被 perEvent 先咬住)", () => {
  const p = execCapPins(320, { EXEC_DAILY_MAX_USD: "300" });
  assert.equal(p.perToken, "320");
  assert.equal(p.perEvent, "320");
});

test("budget 超过日额度 → 抬高并标记 dailyRaised", () => {
  const p = execCapPins(320, { EXEC_DAILY_MAX_USD: "300" });
  assert.equal(p.daily, "320");
  assert.equal(p.dailyRaised, true);
});

test("budget 低于日额度 → 绝不下调生产日额度", () => {
  // 下调会静默削掉同日 chain-watch 的容量,而调用方本意只是给自己设个上限。
  const p = execCapPins(100, { EXEC_DAILY_MAX_USD: "300" });
  assert.equal(p.daily, "300");
  assert.equal(p.dailyRaised, false);
});

test("日额度 env 缺失时按 execConfig 的同一默认值 150 兜底", () => {
  assert.equal(execCapPins(100, {}).daily, "150");
  assert.equal(execCapPins(200, {}).daily, "200");
});

// ── fireDecision:优先级顺序 ───────────────────────────────────

const base = { maxPrice: 0.9, usdmAgeMs: 0, usdmStaleMs: 3600_000, market: "open" as const };

test("正常开火", () => {
  const d = fireDecision({ ...base, ask: 0.68, usdm: "holds" });
  assert.equal(d.fire, true);
  assert.equal(d.halt, false);
});

test("ask 恰好等于追高闸 → 开火(闸是「高于」才拦)", () => {
  assert.equal(fireDecision({ ...base, ask: 0.9, usdm: "holds" }).fire, true);
  assert.equal(fireDecision({ ...base, ask: 0.91, usdm: "holds" }).fire, false);
});

test("revoked 排在最前:即使盘口是空的也必须 halt", () => {
  // 顺序保护。若把"盘口无卖单"的短路排在前面,R1 这道硬闸会被数据可用性掩盖
  // —— 空盘的那些轮次永远走不到撤回判定,而撤回恰恰可能伴随盘口异动。
  const d = fireDecision({ ...base, ask: null, usdm: "revoked" });
  assert.equal(d.halt, true);
  assert.equal(d.fire, false);
});

test("revoked 优先于市场已关闭", () => {
  assert.equal(fireDecision({ ...base, ask: 0.68, usdm: "revoked", market: "closed" }).halt, true);
});

test("unreadable:停火但绝不 halt", () => {
  const d = fireDecision({ ...base, ask: 0.68, usdm: "unreadable" });
  assert.equal(d.fire, false);
  assert.equal(d.halt, false, "读不到 ≠ 被撤回,不可落 kill-switch");
});

test("unreadable 未超 stale 阈值 → 不告警;超了 → 告警", () => {
  assert.equal(fireDecision({ ...base, ask: 0.68, usdm: "unreadable", usdmAgeMs: 10 * 60_000 }).alert, false);
  assert.equal(fireDecision({ ...base, ask: 0.68, usdm: "unreadable", usdmAgeMs: 90 * 60_000 }).alert, true);
});

test("从未成功读到过(age=Infinity)→ 告警且不开火", () => {
  const d = fireDecision({ ...base, ask: 0.68, usdm: "unreadable", usdmAgeMs: Number.POSITIVE_INFINITY });
  assert.equal(d.fire, false);
  assert.equal(d.alert, true);
});

test("市场关闭 / 空盘 / 追高:都只是不开火,不 halt 不告警", () => {
  for (const d of [
    fireDecision({ ...base, ask: 0.68, usdm: "holds", market: "closed" }),
    fireDecision({ ...base, ask: null, usdm: "holds" }),
    fireDecision({ ...base, ask: 0.97, usdm: "holds" }),
  ]) {
    assert.equal(d.fire, false);
    assert.equal(d.halt, false);
    assert.equal(d.alert, false);
  }
});

// ── 市场三态:"抓不到" 绝不可当成 "已关闭"(2026-08-09 修的真实缺陷)──

test("市场抓不到 → 停火但**不收工**,这是本次修复的核心", () => {
  // 修复前:循环里 `marketOpen = m != null && ...` 把抓取失败折叠成 false,
  // 于是一次几秒的 Gamma 抖动 → 判定"市场已关闭" → 发收工邮件 → return 退出,
  // 而窗口还开着、仓位还等着补。08-08 18:00 与 08-09 02:10 两次瞬断是实证。
  const d = fireDecision({ ...base, ask: 0.68, usdm: "holds", market: "unreadable" });
  assert.equal(d.fire, false, "读不到就不该下单");
  assert.equal(d.closed, false, "读不到 ≠ 已关闭,绝不可触发收工退出");
  assert.equal(d.halt, false);
  assert.equal(d.alert, false, "单轮读不到不告警,连败门槛由 transientDecision 管");
  assert.match(d.why, /读不到 ≠ 已关闭/);
});

test("市场**确证**关闭才置 closed=true(收工的唯一入口)", () => {
  assert.equal(fireDecision({ ...base, ask: 0.68, usdm: "holds", market: "closed" }).closed, true);
  assert.equal(fireDecision({ ...base, ask: 0.68, usdm: "holds", market: "open" }).closed, false);
});

test("USDM revoked 优先于市场读不到(halt 不被数据可用性掩盖)", () => {
  const d = fireDecision({ ...base, ask: null, usdm: "revoked", market: "unreadable" });
  assert.equal(d.halt, true);
  assert.equal(d.closed, false);
});

// ── withRetry:轮内重试 ────────────────────────────────────────

test("withRetry:首次成功就不重试", async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls += 1;
    return { ok: true as const, data: 42 };
  }, [1, 2], async () => {});
  assert.equal(calls, 1);
  assert.equal(r.tries, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.outcome, { ok: true, data: 42 });
});

test("withRetry:失败两次后成功 —— 正是两次生产事故的形态", async () => {
  let calls = 0;
  const r = await withRetry<number>(async () => {
    calls += 1;
    return calls < 3 ? { ok: false, err: `HTTP 502 #${calls}` } : { ok: true, data: 7 };
  }, [1, 2], async () => {});
  assert.equal(calls, 3);
  assert.equal(r.tries, 3);
  assert.deepEqual(r.errors, ["HTTP 502 #1", "HTTP 502 #2"]);
  assert.equal(r.outcome.ok && r.outcome.data, 7);
});

test("withRetry:全失败返回最后一个错误,且尝试次数 = 退避档数 + 1", async () => {
  let calls = 0;
  const r = await withRetry<number>(async () => {
    calls += 1;
    return { ok: false, err: `TimeoutError #${calls}` };
  }, [1, 2], async () => {});
  assert.equal(calls, 3, "3 次尝试 = 首次 + 2 档退避");
  assert.equal(r.outcome.ok, false);
  assert.equal(r.outcome.ok === false && r.outcome.err, "TimeoutError #3");
  assert.equal(r.errors.length, 3, "每次的原因都要留下,不能只留最后一个");
});

test("withRetry:退避顺序按给定梯度,且最后一次失败后不再多睡一次", async () => {
  const slept: number[] = [];
  await withRetry<number>(async () => ({ ok: false, err: "x" }), [1_000, 3_000], async (ms) => {
    slept.push(ms);
  });
  assert.deepEqual(slept, [1_000, 3_000], "3 次尝试之间只有 2 次退避");
});

// ── transientDecision:连败门槛 ────────────────────────────────

const NOW = "2026-08-09T02:10:00.000Z";
const LATER = "2026-08-09T02:20:00.000Z";

test("第一轮失败不告警(阈值 3)—— 这正是要消掉的噪音", () => {
  const t = transientDecision(null, NOW, "HTTP 502", 3);
  assert.equal(t.next.count, 1);
  assert.equal(t.alert, false);
  assert.equal(t.next.firstAtIso, NOW);
});

test("连续到阈值才告警,且此后每轮仍返回 true(由小时戳 key 收成每小时一封)", () => {
  const a = transientDecision(null, NOW, "e1", 3);
  const b = transientDecision(a.next, LATER, "e2", 3);
  const c = transientDecision(b.next, LATER, "e3", 3);
  const d = transientDecision(c.next, LATER, "e4", 3);
  assert.deepEqual([a.alert, b.alert, c.alert, d.alert], [false, false, true, true]);
  assert.equal(c.next.count, 3);
  assert.equal(d.next.lastErr, "e4", "邮件里要显示最后一次的原因");
});

test("firstAtIso 保留首次失败时刻(排查要的是「从什么时候开始坏的」)", () => {
  const a = transientDecision(null, NOW, "e1", 3);
  const b = transientDecision(a.next, LATER, "e2", 3);
  assert.equal(b.next.firstAtIso, NOW);
});

test("阈值 1 = 恢复旧行为(单轮即告警);阈值 0/负数按 1 处理", () => {
  assert.equal(transientDecision(null, NOW, "e", 1).alert, true);
  assert.equal(transientDecision(null, NOW, "e", 0).alert, true, "阈值 0 不可退化成「永不告警」");
  assert.equal(transientDecision(null, NOW, "e", -5).alert, true);
});

test("成功后计数被调用方清空 ⟹ 下次失败从 1 重新起算(prev=null 即此语义)", () => {
  // 不清空的后果:上周那次抖动会和今天这次拼成"连败 2",阈值形同虚设。
  assert.equal(transientDecision(null, LATER, "e", 3).next.count, 1);
});

// ── isExhausted:降频判据与 tradeExecutor 的文案对齐 ──────────

test("识别额度/深度耗尽的 skip 文案", () => {
  assert.equal(isExhausted("该 token 累计敞口已满(净 $320/320;毛额 $320…)"), true);
  assert.equal(isExhausted("日额度已满($320/320)"), true);
  assert.equal(isExhausted("未结算持仓已满($800/800)"), true);
  assert.equal(isExhausted("同事件聚合敞口已满($320/320,event 744056)"), true);
  assert.equal(isExhausted("可用额度/限价内深度不足(可下 $3,最低 $5;深度 $3…)"), true);
});

test("非耗尽类 skip 不被误判为耗尽(否则会错误降频、错过补货)", () => {
  assert.equal(isExhausted("盘口无卖单"), false);
  assert.equal(isExhausted("kill-switch 存在(data/trading-halt)"), false);
  assert.equal(isExhausted("ask 0.970 > 上限 0.930(调用方帽;尾价/已重定价)"), false);
  assert.equal(isExhausted(undefined), false);
});

// ── priceCapFor:追高闸与成交价帽之间只留一档 ──────────────────

test("价格帽 = 追高闸 + 1 档,不是 + 滑点带", () => {
  // 这一条锁的是 2026-08-08 边际测算暴露的洞:帽取 --max-price + EXEC_SLIPPAGE
  // (0.95+0.03=0.98)时,limitPriceFor 会在 ask=0.95 那一刻把限价扩到 0.98,
  // FAK 扫穿 0.96/0.97/0.98 —— 正是被判为"期望值约零、波动全损"的那 62 股。
  // release-sniper 留那个宽度是为竞速场景的成交量;本盘 5 天窗口 + 20s 轮询,
  // 这一轮没吃到下一轮还在,宽度换不来任何东西。
  assert.equal(priceCapFor(0.95), 0.96);
  assert.equal(priceCapFor(0.9), 0.91);
  assert.equal(priceCapFor(0.99), 0.999, "0.99+1档=1.00 越过协议上限,钳到 0.999");
});

test("价格帽不越过 CLOB 协议上限 0.999(≥1.0 会被拒单)", () => {
  assert.equal(priceCapFor(0.999), 0.999);
  assert.equal(priceCapFor(1.5), 0.999);
});

test("低价位时帽不咬住 —— 滑点带完整保留", () => {
  // limitPriceFor(0.72, declarative) = 0.76,远低于 priceCapFor(0.95) = 0.96,
  // 所以帽在常规价位上对行为零影响。这是"只在需要它咬的窄区间咬住"的含义。
  assert.ok(0.76 < priceCapFor(0.95));
  assert.ok(0.87 < priceCapFor(0.95), "ask 0.83 档的限价也仍在帽内");
});

// ── 分层额度(2026-08-08:闸门按机会质量分级)──────────────────

test("parseTiers:正常解析并按价升序", () => {
  const { tiers, bad } = parseTiers(["0.85:500", "0.80:800"]);
  assert.deepEqual(bad, []);
  assert.deepEqual(tiers, [
    { maxAsk: 0.8, usd: 800 },
    { maxAsk: 0.85, usd: 500 },
  ]);
});

test("parseTiers:非法项被丢进 bad 而不是变成 NaN 预算", () => {
  // NaN 预算会在 executeSignal 的 min() 里把订单静默缩成 0 —— 现场症状是
  // "引擎莫名不买了",最难排查的那一类。调用方据 bad 拒绝启动。
  const { tiers, bad } = parseTiers(["0.8:abc", "abc:500", "0.8", "1.5:500", "0.8:0", "-0.1:500", "0.85:500"]);
  assert.deepEqual(tiers, [{ maxAsk: 0.85, usd: 500 }]);
  assert.equal(bad.length, 6, `应有 6 个非法项,实际 ${JSON.stringify(bad)}`);
});

test("budgetForAsk:取最先命中的低价档", () => {
  const { tiers } = parseTiers(["0.80:800", "0.85:500"]);
  assert.equal(budgetForAsk(0.72, tiers, 330).usd, 800, "0.72 命中 ≤0.80 档");
  assert.equal(budgetForAsk(0.8, tiers, 330).usd, 800, "边界含等号");
  assert.equal(budgetForAsk(0.81, tiers, 330).usd, 500, "越过 0.80 落到 ≤0.85 档");
  assert.equal(budgetForAsk(0.85, tiers, 330).usd, 500);
});

test("budgetForAsk:都不命中 → fallback(贵的腿维持原额度)", () => {
  const { tiers } = parseTiers(["0.80:800", "0.85:500"]);
  assert.equal(budgetForAsk(0.9, tiers, 330).usd, 330);
  assert.equal(budgetForAsk(0.9, tiers, 330).tier, null);
});

test("budgetForAsk:无分层 / ask 未知 → fallback", () => {
  assert.equal(budgetForAsk(0.72, [], 330).usd, 330);
  assert.equal(budgetForAsk(null, parseTiers(["0.80:800"]).tiers, 330).usd, 330);
});

test("execCapPins 每轮以原始 env 为基线,日额度不会跨轮单调爬升", () => {
  // 若拿上一轮写回的 process.env 当基线,一次 0.72 档抬到 $800 之后,后面所有
  // 轮次(哪怕 ask 0.90 该回落到 $330)的日额度都永久停在 $800 —— 这个错误在
  // 日志上只是一个偏大的数字,不会报错。applyCaps 因此固定传 dailyBaseline。
  const baseline = { EXEC_DAILY_MAX_USD: "300" };
  assert.equal(execCapPins(800, baseline).daily, "800", "低价档抬高");
  assert.equal(execCapPins(330, baseline).daily, "330", "回到贵档时以原始 300 为基线,不残留 800");
  assert.equal(execCapPins(200, baseline).daily, "300", "低于原始值时绝不下调");
});

// ── 单笔上限随 tier 抬高(2026-08-08 A 方案)────────────────────

const ENV_PROD = { EXEC_DAILY_MAX_USD: "300", EXEC_MAX_ORDER_USD: "100" };

test("命中 tier → 单笔上限抬到当档预算(解掉 cron 每轮 $100 的限速)", () => {
  // 低价档把 per-token 抬到 $800 后,真正的限速器变成单笔 $100:cron 每 10 分钟
  // 一轮,吃满 $378 要 4 轮 40 分钟,而 ask≤0.80 的低价抛单更容易被抢走。
  const p = execCapPins(800, ENV_PROD, { raiseMaxOrder: true });
  assert.equal(p.maxOrder, "800");
  assert.equal(p.maxOrderRaised, true);
});

test("未命中 tier(fallback 档)→ 单笔上限维持生产默认,不悄悄放开常规风控", () => {
  const p = execCapPins(330, ENV_PROD); // 不传 raiseMaxOrder
  assert.equal(p.maxOrder, "100");
  assert.equal(p.maxOrderRaised, false);
});

test("单笔上限只抬不降:tier 预算低于生产单笔时保持原值", () => {
  const p = execCapPins(60, ENV_PROD, { raiseMaxOrder: true });
  assert.equal(p.maxOrder, "100", "不能因为某档预算小就把生产单笔上限调低");
  assert.equal(p.maxOrderRaised, false);
});

test("单笔上限以原始 env 为基线,不跨轮单调爬升", () => {
  // 与 daily 同一个陷阱:拿上一轮写回的 process.env 当基线,一次 0.80 档抬到
  // $800 后,后面所有轮次都永久停在 $800。applyCaps 固定传 maxOrderBaseline。
  assert.equal(execCapPins(800, ENV_PROD, { raiseMaxOrder: true }).maxOrder, "800");
  assert.equal(execCapPins(330, ENV_PROD).maxOrder, "100", "回到 fallback 档时以原始 100 为基线,不残留 800");
});

test("env 缺失时按 execConfig 的同一默认值 50 兜底", () => {
  assert.equal(execCapPins(30, {}, { raiseMaxOrder: true }).maxOrder, "50");
  assert.equal(execCapPins(800, {}, { raiseMaxOrder: true }).maxOrder, "800");
});

test("execCapPins 永不返回总敞口 —— 分层对 EXEC_TOTAL_MAX_USD 无任何入口", () => {
  // 这条是边界的形式化断言。总敞口保护的是"所有判断同时错"的账户级情形;
  // 一旦有人给它加了放宽入口,分层就从"单机会规模分级"变成了"账户风控可绕过"。
  const p = execCapPins(800, { ...ENV_PROD, EXEC_TOTAL_MAX_USD: "800" }, { raiseMaxOrder: true });
  assert.deepEqual(Object.keys(p).sort(), ["daily", "dailyRaised", "maxOrder", "maxOrderRaised", "perEvent", "perToken"]);
  assert.ok(!("total" in p) && !("totalMax" in p));
});
