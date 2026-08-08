/**
 * release-sniper 档位映射回归(2026-08-05)。
 *
 * 为什么这个文件必须存在:bucket 型档位映射是 07-10 审计点名的"硬错误
 * 集中地"(P0-2④ 把 bucket-contains/bucket-anti 逐出自动执行白名单)。
 * CSU 三档虽然只有一个整数、比 NFP 的 "between 50k and 100k" 简单得多,
 * 但**写错一档就是 −100%**,而它今晚要驱动实弹下单。
 *
 * 判据取自市场条款原文:
 *   · 小数四舍五入到最近整数,.5 进位
 *   · 区间取中点向下取整(CSU headline 历来是整数,此项仅为兜底)
 *   · 三档 = ≤7 / =8 / ≥9,必须恰好命中一档(命中 0 或 ≥2 → fail-closed 返回 null)
 *
 * 全部离线:纯函数,无 fs/网络。运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bracketFor, fireGate, execCapPins } from "../scripts/release-sniper";

test("整数值落进正确档位", () => {
  assert.equal(bracketFor(0)?.short, "≤7");
  assert.equal(bracketFor(6)?.short, "≤7");
  assert.equal(bracketFor(7)?.short, "≤7");
  assert.equal(bracketFor(8)?.short, "=8");
  assert.equal(bracketFor(9)?.short, "≥9");
  assert.equal(bracketFor(13)?.short, "≥9");
});

test("7/8 边界:7.4 归 ≤7,7.5 进位到 =8", () => {
  assert.equal(bracketFor(7.4)?.short, "≤7");
  assert.equal(bracketFor(7.5)?.short, "=8", ".5 必须进位(条款原文),不能银行家舍入到 8 以外");
  assert.equal(bracketFor(7.6)?.short, "=8");
});

test("8/9 边界:8.4 归 =8,8.5 进位到 ≥9", () => {
  assert.equal(bracketFor(8.4)?.short, "=8");
  assert.equal(bracketFor(8.5)?.short, "≥9");
  assert.equal(bracketFor(8.9)?.short, "≥9");
});

test("命中的 question 原文必须与 Gamma 上的一字不差", () => {
  // 这三条是 buildLegs 的启动硬门槛(对不上就拒绝启动)。此处锁死文案,
  // 防止有人图省事改了 BRACKETS 里的字符串却没同步改比对逻辑。
  assert.equal(bracketFor(7)?.question, "Will CSU forecast 7 or fewer named storms?");
  assert.equal(bracketFor(8)?.question, "Will CSU forecast 8 named storms?");
  assert.equal(bracketFor(9)?.question, "Will CSU forecast 9 or more named storms?");
});

test("每个值恰好命中一档 —— 谓词表不许有缝或重叠", () => {
  // 0..30 全扫一遍:任何一个值返回 null 都意味着 BRACKETS 表有洞或有重叠,
  // 而 fireAndRefill 只在拿到唯一档位时才下单。
  for (let n = 0; n <= 30; n += 1) {
    assert.ok(bracketFor(n) != null, `值 ${n} 没有映射出唯一档位`);
  }
  for (let h = 0; h <= 300; h += 1) {
    const v = h / 10; // 0.0 .. 30.0,覆盖所有一位小数
    assert.ok(bracketFor(v) != null, `值 ${v} 没有映射出唯一档位`);
  }
});

test("fireGate:②∧③ 即开火,pdfLive 不再是前置条件(2026-08-07 行为变更)", () => {
  // 这一刀就是 08-06 定调("风险预算从确认强度搬到仓位")的落码:稳定期满、
  // PDF 未上线 → 照样开火,只是要带起 ① 的事后纠错 watcher。08-05 实测首页
  // 领先 PDF 37s、0x2fdb 在页面更新 15s 后不等 PDF 扫光 0.727 —— 谁把
  // pdfLive 改回开火前置,这里会响。
  assert.deepEqual(fireGate({ stableMs: 2000, stableThresholdMs: 2000, pdfLive: false }), {
    fire: true,
    watchPdf: true,
  });
  assert.deepEqual(fireGate({ stableMs: 2000, stableThresholdMs: 2000, pdfLive: true }), {
    fire: true,
    watchPdf: false,
  });
  // ③ 未满仍不开火 —— 放宽的是 ①,不是稳定期;不开火也不起 watcher。
  assert.deepEqual(fireGate({ stableMs: 1999, stableThresholdMs: 2000, pdfLive: false }), {
    fire: false,
    watchPdf: false,
  });
});

test("execCapPins:同事件帽跟 per-token 一起钉到 USD*4(2026-08-07 核验 §1.4)", () => {
  // 不钉 per-event 时默认 2×EXEC_MAX_ORDER_USD 在 executeSignal 的 min() 里
  // 先咬住,声明的 USD*4 补仓容量实际只有一半(08-05 CSU $165 成交离 $200
  // 帽只差 $35)。三档互斥只买一条腿,事件帽在本脚本语义下 ≡ token 帽。
  const pins = execCapPins(100, { EXEC_MAX_ORDER_USD: "100" });
  assert.equal(pins.maxOrder, "100");
  assert.equal(pins.perToken, "400");
  assert.equal(pins.perEvent, "400");
  // 只提供默认,不覆盖显式运维配置。
  assert.equal(
    execCapPins(100, { EXEC_MAX_ORDER_USD: "100", EXEC_PER_EVENT_MAX_USD: "150" }).perEvent,
    "150"
  );
  assert.equal(
    execCapPins(100, { EXEC_MAX_ORDER_USD: "100", EXEC_PER_TOKEN_MAX_USD: "250" }).perToken,
    "250"
  );
  // 单笔仍只收紧不放宽:--usd 大于 env 上限时以 env 为准;env 缺失时兜底 50。
  assert.equal(execCapPins(200, { EXEC_MAX_ORDER_USD: "100" }).maxOrder, "100");
  assert.equal(execCapPins(30, {}).maxOrder, "30");
  assert.equal(execCapPins(80, {}).maxOrder, "50");
});
