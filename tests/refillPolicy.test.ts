/**
 * R1 回归(2026-08-02 复查):成交后补仓复访的出队判据必须看 **reason**,不是
 * status。第一轮修复把判据反转成 `status === "skipped" → 出队`,于是复访第一次
 * 最可能命中的两种 skip(限价内深度被自己吃空 / 信号后已重定价)被当成终局,
 * 12 分钟补仓窗口在第一次复访就被自己关掉 —— 复现 07-28 原型:21:21 成交 $47
 * 吃干限价内 ~$52 深度,21:26 挂出的 85 股 ≤0.69 无人复访,被他人吃走且全部
 * 结算 $1。
 *
 * 本文件全部离线:纯函数 + 手搓的 TradeAttempt,无 fs/网络/子进程。
 * reason 文案逐字取自 lib/polymarket/tradeExecutor.ts 的 executeSignal
 * (行号见各断言旁注),不是臆造的近似串 —— 判据是正则,文案对不上就等于没测。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldKeepInRefillQueue,
  REFILL_TRANSIENT_SKIP,
  REFILL_TERMINAL_SKIP,
} from "../lib/polymarket/refillPolicy";
import type { TradeAttempt } from "../lib/polymarket/tradeExecutor";

/** 复访 skip 的最小骨架:判据只读 status/reason/posted。 */
const skip = (reason: string): TradeAttempt => ({ mode: "live", status: "skipped", reason });
/** 断言时吞掉那行"未识别 reason"的 warn,并把它交回来供断言。 */
const keepWithWarn = (a: TradeAttempt): { keep: boolean; warns: string[] } => {
  const warns: string[] = [];
  const keep = shouldKeepInRefillQueue(a, (m) => void warns.push(m));
  return { keep, warns };
};

test("R1:限价内深度不足 / 信号后已重定价 = 瞬态,必须留队(补仓窗口不许自己关掉)", () => {
  // tradeExecutor.ts:1123 —— depthUsd 是**限价内**深度,刚被自己吃干后必然
  // 塌到 minOrderUsd($5) 以下。这正是 12 分钟窗口存在的全部理由。
  assert.equal(
    shouldKeepInRefillQueue(
      skip("可用额度/限价内深度不足(可下 $3,最低 $5;深度 $3,token余额 $53/日 $753/总 $753)")
    ),
    true
  );
  // tradeExecutor.ts:1093 —— 锚恒为原始信号价,自己吃掉 ≤0.69 的档位后 freshAsk
  // 抬到 0.750 就越带;12 分钟内补货回落是常态。
  assert.equal(
    shouldKeepInRefillQueue(skip("信号后已重定价(注解 0.664 → 现 0.750,超漂移带 0.050)")),
    true
  );
  // tradeExecutor.ts:1068 —— 此刻卖侧空,但卖家可能回来,这就是复访的形态本身。
  assert.equal(shouldKeepInRefillQueue(skip("盘口无卖单")), true);
  assert.equal(shouldKeepInRefillQueue(skip("tick 预算不足,跳过下单(剩余 8s)")), true);
});

test("R1:额度/敞口触顶 = 终局,必须出队(窗口内只会更满)", () => {
  // tradeExecutor.ts:998
  assert.equal(shouldKeepInRefillQueue(skip("日额度已满($800/800)")), false);
  // tradeExecutor.ts:966(注意文案前缀是「该 token 累计敞口已满」,故表里用无锚点的词干)
  assert.equal(
    shouldKeepInRefillQueue(
      skip("该 token 累计敞口已满(净 $100/100;毛额 $100,已扣除已结算部分;2026-07-28T21:21:53.718Z filled已持仓$47)")
    ),
    false
  );
  // tradeExecutor.ts:1044
  assert.equal(
    shouldKeepInRefillQueue(skip("同事件聚合敞口已满($300/300,event 744619)")),
    false
  );
  assert.equal(shouldKeepInRefillQueue(skip("未结算持仓已满($800/800)")), false);
  assert.equal(shouldKeepInRefillQueue(skip("结算连亏 3 笔,熔断待人工复核")), false);
  assert.equal(shouldKeepInRefillQueue(skip("kill-switch 存在(data/trading-halt)")), false);
});

test("R1:「盘口无卖单」与「盘口无卖侧挂单」是两条不同的路,锚点不能松", () => {
  // 前者 = 本轮 freshAsk 为空(可自愈);后者 = bestAskAtSignal 缺锚的空盘分支
  // (锚在队列里存死,补货也补不出锚)。两条靠第 5 个字就分得开(「单」vs
  // 「侧」),不存在前缀劫持 —— 分辨力来自前缀本身,不来自尾锚(尾锚为何不能
  // 是 $,见下面 N3 那条)。
  assert.equal(shouldKeepInRefillQueue(skip("盘口无卖单")), true);
  assert.equal(
    shouldKeepInRefillQueue(
      skip("盘口无卖侧挂单(空盘,CLOB book 含镜像对侧)—— taker 任何价位不可成交,人工亦无从下单;吃此腿唯 maker 挂单(策略层,未开)")
    ),
    false
  );
  assert.equal(
    shouldKeepInRefillQueue(skip("信号注解无盘口基准(bestAskAtSignal=null),人工确认后手动下单")),
    false
  );
});

test("N3:ledger 写失败追加后缀后,「盘口无卖单」仍须命中瞬态表(尾锚不能是 $)", () => {
  // reason 并非恒等于 executeSignal 写下的那一串:lib/polymarket/tradeExecutor.ts
  // 的 finish() 在 mode==="live" ∧ appendLedger 抛错(磁盘满/权限)时,会把
  // 「; ledger 写入失败,已自动落 kill-switch」**追加**到 a.reason 尾部。
  // 原式 /^盘口无卖单$/ 恰好在磁盘满事故现场失配 → 掉进"未识别 reason"的 warn,
  // 让运维在事故现场去补一条其实早就在表里的文案(假线索,且掩盖真告警)。
  const withLedgerSuffix = "盘口无卖单; ledger 写入失败,已自动落 kill-switch";
  const { keep, warns } = keepWithWarn(skip(withLedgerSuffix));
  assert.equal(keep, true, "追加 ledger 后缀后必须仍按瞬态留队");
  assert.equal(warns.length, 0, "已登记的文案不得因后缀掉进未识别告警");

  // 放宽只到 ";" 为止:任何**别的**新后缀仍要失配并照常报警,不得被静默吞进
  // 瞬态表 —— 这半条才是 (?![^;]) 比裸前缀严的地方,漏了它等于退化成 /^盘口无卖单/。
  const unknownSuffix = keepWithWarn(skip("盘口无卖单(某个日后新增的括号注解)"));
  assert.equal(unknownSuffix.keep, false, "未登记的新后缀必须走保守出队");
  assert.equal(unknownSuffix.warns.length, 1, "未登记的新后缀必须报警");

  // 空盘那条即便也被追加同一后缀,仍须留在终局表(前缀分辨力与后缀无关)。
  assert.equal(
    shouldKeepInRefillQueue(skip(`盘口无卖侧挂单(空盘,CLOB book 含镜像对侧); ledger 写入失败,已自动落 kill-switch`)),
    false
  );
});

test("R1:非 skipped 分支 —— 成交/none 留队,error 仅在确知未发出时留队", () => {
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "filled", filledUsd: 47 }), true);
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "partial", filledUsd: 12 }), true);
  // FAK 已发出但零成交 —— 限价内当时无对手,下个 tick 可能就挂出来了
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "none", posted: true }), true);
  // fail-closed:单可能已在链上,重试等于对未知持仓再加一腿
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "error", posted: true }), false);
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "error", posted: "unknown" }), false);
  assert.equal(shouldKeepInRefillQueue({ mode: "live", status: "error", posted: false }), true);
  // dry 不该占复访预算
  assert.equal(shouldKeepInRefillQueue({ mode: "dry", status: "dry" }), false);
});

test("R1:未识别的 skip 原因 → 出队(保守)且必须报警,不许静默", () => {
  const { keep, warns } = keepWithWarn(skip("某个尚未登记的新 skip 文案"));
  assert.equal(keep, false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /未识别的 skip 原因/);
  assert.match(warns[0], /REFILL_TRANSIENT_SKIP\/REFILL_TERMINAL_SKIP/);
  // 已识别的原因不得报警(否则运维每 tick 被噪声淹没,真失配就看不见了)
  assert.equal(keepWithWarn(skip("日额度已满($800/800)")).warns.length, 0);
  assert.equal(keepWithWarn(skip("盘口无卖单")).warns.length, 0);
});

test("R1:两张表互斥 —— 同一条 reason 不得同时命中瞬态与终局", () => {
  // 双表命中会让判定悄悄依赖表内顺序(瞬态先查即赢),这类耦合必须钉死。
  const samples = [
    "可用额度/限价内深度不足(可下 $3,最低 $5;深度 $3,token余额 $53/日 $753/总 $753)",
    "信号后已重定价(注解 0.664 → 现 0.750,超漂移带 0.050)",
    "盘口无卖单",
    "tick 预算不足,跳过下单(剩余 8s)",
    "日额度已满($800/800)",
    "该 token 累计敞口已满(净 $100/100;毛额 $100,已扣除已结算部分;2026-07-28T21:21:53.718Z filled)",
    "同事件聚合敞口已满($300/300,event 744619)",
    "未结算持仓已满($800/800)",
    "盘口无卖侧挂单(空盘,CLOB book 含镜像对侧)—— taker 任何价位不可成交",
    "信号注解无盘口基准(bestAskAtSignal=null),人工确认后手动下单",
    "盘口反向暴跌(注解 0.664 → 现 0.400,跌破 0.100)",
    "ask 0.985 > 上限 0.970(尾价/已重定价)",
    "预告家族防雷:方向侧信号价 0.220 < 0.30,不执行",
    "EXEC_MODE=off",
    "kill-switch 存在(data/trading-halt)",
    "结算连亏 3 笔,熔断待人工复核",
    "proxy USDC 余额不足($3.20 < $5)",
    "CLOB 拒单(余额不足)",
    "同市场已持反向腿(token 0x1234…,敞口 $47)",
    "市场已关闭",
  ];
  for (const r of samples) {
    const t = REFILL_TRANSIENT_SKIP.some((x) => x.re.test(r));
    const f = REFILL_TERMINAL_SKIP.some((re) => re.test(r));
    assert.ok(t !== f, `reason 必须恰好命中一张表(瞬态=${t} 终局=${f}): ${r}`);
  }
});
