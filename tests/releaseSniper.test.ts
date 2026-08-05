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
import { bracketFor } from "../scripts/release-sniper";

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
