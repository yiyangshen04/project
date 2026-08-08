/**
 * P0-2 回归(2026-07-10 实盘盈利审计 §2.2):directionalOutcomeIndex 的
 * 后缀劫持与 fallback 行为,stancePolarity 整串收紧。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionalOutcomeIndex, stancePolarity, effectiveCeilingConfig } from "../lib/polymarket/execCheck";

test("resolve_to_* 以 -no/-yes 结尾的标签不再被 YES/NO 后缀正则劫持", () => {
  // 修复前:/NO$/i.test("resolve_to_bruno")===true → no-side → outcomes 里没有
  // "no" → fallback 固定下标 → 买任意 token,确定性 -100%
  assert.deepEqual(
    directionalOutcomeIndex("resolve_to_bruno", ["Bruno", "Mannarino"], "Who wins?"),
    { index: 0, method: "outcome-exact" }
  );
  assert.deepEqual(
    directionalOutcomeIndex("resolve_to_hayes", ["Reyes", "Hayes"], "Who wins?"),
    { index: 1, method: "outcome-exact" }
  );
});

test("resolve_to_* 在 yes/no 市场仍走 bucket 启发式(白名单只挡自动执行,不挡邮件)", () => {
  assert.deepEqual(
    directionalOutcomeIndex("resolve_to_bruno", ["Yes", "No"], "Will Bruno win the match?"),
    { index: 0, method: "bucket-contains" }
  );
  assert.deepEqual(
    directionalOutcomeIndex("resolve_to_bruno", ["Yes", "No"], "Will Torino qualify?"),
    { index: 1, method: "bucket-anti" }
  );
});

test("resolve_to_* 在非 yes/no 市场且无 outcome 匹配 → null(不猜下标)", () => {
  assert.equal(directionalOutcomeIndex("resolve_to_smith", ["Bruno", "Mannarino"], "Who wins?"), null);
});

test("YES/NO/leans_* 仅在 outcome 集合里真有 yes/no 时映射,否则 null 而非 fallback", () => {
  assert.deepEqual(directionalOutcomeIndex("YES", ["Yes", "No"], null), { index: 0, method: "yes-side" });
  assert.deepEqual(directionalOutcomeIndex("leans_NO", ["Yes", "No"], null), { index: 1, method: "no-side" });
  assert.deepEqual(directionalOutcomeIndex("NO", ["No", "Yes"], null), { index: 0, method: "no-side" });
  // 修复前:YES → 固定 index 0,NO → 固定 index 1
  assert.equal(directionalOutcomeIndex("YES", ["Hayes", "Reyes"], null), null);
  assert.equal(directionalOutcomeIndex("NO", ["Bruno", "Mannarino"], null), null);
});

test("stancePolarity 整串匹配:resolve_to_* 不再被归为 +/-,保持字面一致比较", () => {
  assert.equal(stancePolarity("YES"), "+");
  assert.equal(stancePolarity("leans_YES"), "+");
  assert.equal(stancePolarity("NO"), "-");
  assert.equal(stancePolarity("leans_NO"), "-");
  // 修复前:"resolve_to_hayes" → "+"、"resolve_to_bruno" → "-",
  // 「双方判读一致却买反」可达 🟢 闸门
  assert.equal(stancePolarity("resolve_to_hayes"), "resolve_to_hayes");
  assert.equal(stancePolarity("resolve_to_bruno"), "resolve_to_bruno");
});

test("effectiveCeilingConfig:管线帽只收紧不放宽(2026-08-07,0.99 裁决配套)", () => {
  // fillAvail 天花板必须与实盘同一道帽:chain-watch 透传 CHAIN_WATCH_MAX_ASK
  // 后,(帽, EXEC_MAX_PRICE] 的腿不再"paper 登记、实盘 skip"。env 存档/复原,
  // 不污染同进程其它用例。
  const saved = process.env.EXEC_MAX_PRICE;
  delete process.env.EXEC_MAX_PRICE;
  try {
    assert.equal(effectiveCeilingConfig(null).maxPrice, 0.995, "未传帽 = 只按 EXEC_MAX_PRICE 默认");
    assert.equal(effectiveCeilingConfig(undefined).maxPrice, 0.995);
    assert.equal(effectiveCeilingConfig(0.99).maxPrice, 0.99, "chain-watch 透传后 paper 与实盘同口径");
    assert.equal(effectiveCeilingConfig(1.5).maxPrice, 0.995, "放宽不允许(与 executeSignal.maxPriceCap 同语义)");
    assert.equal(effectiveCeilingConfig(0).maxPrice, 0.995, "非法值当没传");
    assert.equal(effectiveCeilingConfig(NaN).maxPrice, 0.995, "非法值当没传");
    // 另两个键不受帽影响
    const cfg = effectiveCeilingConfig(0.99);
    assert.equal(cfg.slippage, 0.03);
    assert.equal(cfg.slippageEdgeFrac, 0.15);
  } finally {
    if (saved !== undefined) process.env.EXEC_MAX_PRICE = saved;
    else delete process.env.EXEC_MAX_PRICE;
  }
});
