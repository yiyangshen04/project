/**
 * P0-1 回归(2026-07-10 实盘盈利审计 §2.1):额度求和口径 exposedUsd ——
 * 零成交/明确拒单不占额度,partial 按实际成交,postOrder 超时保守按 requested。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exposedUsd,
  upDriftBand,
  crashDropThreshold,
  findOppositeLeg,
  consecutiveLossTail,
  computeSettlementPnl,
  collapseAttempts,
  isTransportAmbiguous,
  lossHaltTripped,
  settledFinal,
  takerFeeUsd,
} from "../lib/polymarket/tradeExecutor";

test("filled/partial 按 filledUsd 计,而非 requestedUsd", () => {
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100, filledUsd: 97.5 }), 97.5);
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100, filledUsd: 37 }), 37);
});

test("FAK 零成交与 CLOB 明确拒单(posted=true 但无成交)不占额度", () => {
  // 修复前:posted=true 即按 requestedUsd 终身累计,8 次零成交尝试就打满 $800
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100 }), 0);
});

test("postOrder 超时(posted=unknown,交易所可能已受理)保守按 requestedUsd", () => {
  assert.equal(exposedUsd({ mode: "live", posted: "unknown", requestedUsd: 100 }), 100);
});

test("未发出(posted=false)、dry、probe 一律不占额度", () => {
  assert.equal(exposedUsd({ mode: "live", posted: false, requestedUsd: 100 }), 0);
  assert.equal(exposedUsd({ mode: "dry", posted: false, requestedUsd: 100 }), 0);
  assert.equal(exposedUsd({ mode: "live", probe: true, posted: true, requestedUsd: 1, filledUsd: 1 }), 0);
});

// ── §2.3 漂移带形状(2026-07-11)──

test("上行漂移带按剩余边缩放:低价位放宽(Norway 0.164→0.20 放行),高价位不变", () => {
  // 0.164:带宽 = max(0.03, 0.15×0.836) ≈ 0.125 → 0.20 在带内(旧绝对带 0.03 会拒单)
  const band = upDriftBand(0.164, 0.03, 0.15);
  assert.ok(0.2 <= 0.164 + band, `0.20 应在带内(band=${band})`);
  // 0.90:退化回绝对带,不收紧既有行为
  assert.equal(upDriftBand(0.9, 0.03, 0.15), 0.03);
});

test("下行暴跌阈值:高价位按比例,极低价位不低于绝对滑点", () => {
  assert.ok(Math.abs(crashDropThreshold(0.9, 0.03, 0.35) - 0.315) < 1e-9);
  assert.equal(crashDropThreshold(0.05, 0.03, 0.35), 0.03);
});

// ── §7 翻向双腿保护 ──

test("findOppositeLeg:同 conditionId 不同 tokenId 且有敞口才算冲突", () => {
  const held = { conditionId: "0xc1", tokenId: "A", mode: "live" as const, posted: true as const, filledUsd: 50, requestedUsd: 50 };
  assert.ok(findOppositeLeg([held], "0xc1", "B"));
  assert.equal(findOppositeLeg([held], "0xc1", "A"), undefined); // 同 token 走 dedup,不算翻向
  assert.equal(findOppositeLeg([held], "0xc2", "B"), undefined); // 不同市场
  assert.equal(findOppositeLeg([held], undefined, "B"), undefined);
  // 零成交(无敞口)不封锁翻向
  const noFill = { ...held, filledUsd: undefined };
  assert.equal(findOppositeLeg([noFill], "0xc1", "B"), undefined);
});

// ── P0-4 结算对账 ──

test("computeSettlementPnl:赢单/输单按结算价核算,outcome 不匹配宁缺毋错", () => {
  const win = computeSettlementPnl([{ outcome: "Yes", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]);
  assert.equal(win?.pnlUsd, 10);
  assert.equal(win?.won, true);
  const loss = computeSettlementPnl([{ outcome: "No", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]);
  assert.equal(loss?.pnlUsd, -90);
  assert.equal(loss?.won, false);
  assert.equal(computeSettlementPnl([{ outcome: "Bruno", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]), null);
  assert.equal(computeSettlementPnl([{ outcome: "Yes" }], ["Yes", "No"], [1, 0]), null); // 无成交明细
});

// ── §2 taker 费记账(2026-07-19 审查)──

test("takerFeeUsd:免费市场 $0;实收 = filledUsd×rate×(1−p);费率未知按平费 0.002", () => {
  assert.equal(takerFeeUsd(100, 0.5, false, null), 0);
  // rate=0.04 @ p=0.5:100×0.04×0.5 = $2
  assert.equal(takerFeeUsd(100, 0.5, true, 0.04), 2);
  // 尾价区被 (1−p) 压小:p=0.95 → 100×0.04×0.05 = $0.20
  assert.equal(takerFeeUsd(100, 0.95, true, 0.04), 0.2);
  // 未知(注解缺失)→ 平费兜底,宁多计不少计
  assert.equal(takerFeeUsd(100, 0.5, null, null), 0.2);
  assert.equal(takerFeeUsd(100, 0.5, undefined, undefined), 0.2);
  // feesEnabled=true 但 rate 不可信(越界)→ 同样走平费兜底
  assert.equal(takerFeeUsd(100, 0.5, true, 0.9), 0.2);
});

test("computeSettlementPnl:cost 含 feeUsd —— 含费后薄利赢单如实转亏,存量无费行不受影响", () => {
  // 尾价薄 carry:$97 买 100 股(p=0.97),赢面 payout=$100;费 $2.5 → 含费 cost=$99.5 仍 won
  const thin = computeSettlementPnl(
    [{ outcome: "Yes", filledUsd: 97, filledShares: 100, feeUsd: 2.5 }],
    ["Yes", "No"],
    [1, 0]
  );
  assert.equal(thin?.costUsd, 99.5);
  assert.equal(thin?.pnlUsd, 0.5);
  assert.equal(thin?.won, true);
  // 费再大一点($3.5)→ payout < cost,won 翻 false(修复前系统性偏乐观)
  const flipped = computeSettlementPnl(
    [{ outcome: "Yes", filledUsd: 97, filledShares: 100, feeUsd: 3.5 }],
    ["Yes", "No"],
    [1, 0]
  );
  assert.equal(flipped?.won, false);
  assert.equal(flipped?.pnlUsd, -0.5);
  // 存量行无 feeUsd:按 0 计,行为与修复前一致
  const legacy = computeSettlementPnl([{ outcome: "Yes", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]);
  assert.equal(legacy?.pnlUsd, 10);
});

test("consecutiveLossTail:尾部连亏计数,赢单断链,盈亏未知跳过不断链", () => {
  const rec = (at: string, pnl?: number) => ({ at, pnlUsd: pnl });
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2", -20), rec("3", -30)]), 3);
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2", 5), rec("3", -30)]), 1);
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2"), rec("3", -30)]), 2);
  assert.equal(consecutiveLossTail([rec("1", 5)]), 0);
  assert.equal(consecutiveLossTail([]), 0);
});

// ── 2026-07-11 审计修复批 ──

test("collapseAttempts:终态行取代同 attemptId 的 intent 行,孤儿 intent 保留", () => {
  const intent = { attemptId: "a1", status: "intent", posted: "unknown" as const, requestedUsd: 50 };
  const final_ = { attemptId: "a1", status: "filled", posted: true as const, filledUsd: 48 };
  const orphan = { attemptId: "a2", status: "intent", posted: "unknown" as const, requestedUsd: 30 };
  const legacy = { attemptId: undefined, status: "filled", posted: true as const, filledUsd: 10 }; // 无 attemptId 的历史行
  const out = collapseAttempts([intent, final_, orphan, legacy]);
  assert.deepEqual(out, [final_, orphan, legacy]);
  // 孤儿 intent(进程死在 postOrder 在途窗口)保守占额
  assert.equal(exposedUsd({ mode: "live", posted: "unknown", requestedUsd: 30 }), 30);
});

test("isTransportAmbiguous:{error} 无 status/orderID = 传输层歧义;真拒单带 status 不算", () => {
  assert.equal(isTransportAmbiguous({ error: "socket hang up" }, false), true);
  assert.equal(isTransportAmbiguous({ error: "FAK order ...", status: 400, orderID: "0x1" }, false), false);
  assert.equal(isTransportAmbiguous({ error: "x", status: 502 }, false), false);
  assert.equal(isTransportAmbiguous({ error: "x", orderID: "0x1" }, false), false);
  assert.equal(isTransportAmbiguous({}, false), false);
  assert.equal(isTransportAmbiguous({ error: "x" }, true), false); // 有成交就不是歧义
  assert.equal(isTransportAmbiguous(null, false), false);
});

test("settledFinal:legacy 字符串/带 pnl/pnlUnavailable 为终局;冻结的无 pnl 对象要重探", () => {
  assert.equal(settledFinal("2026-07-01T00:00:00Z"), true);
  assert.equal(settledFinal({ at: "1", pnlUsd: -50 }), true);
  assert.equal(settledFinal({ at: "1", pnlUsd: 0 }), true); // pnl=0 也是终局
  assert.equal(settledFinal({ at: "1", pnlUnavailable: true }), true);
  assert.equal(settledFinal({ at: "1", notified: false }), false); // 修复前冻结的未定型记录
  assert.equal(settledFinal(undefined), false);
});

test("lossHaltTripped:尾亏达阈值触发;水位之后无新亏损不重复熔断", () => {
  const cache = {
    c1: { at: "2026-07-01", pnlUsd: -10 },
    c2: { at: "2026-07-02", pnlUsd: -20 },
    c3: { at: "2026-07-03", pnlUsd: -30 },
  };
  assert.deepEqual(lossHaltTripped(cache, 3), { losses: 3, tripped: true });
  assert.deepEqual(lossHaltTripped(cache, 4), { losses: 3, tripped: false });
  // 已熔断过(水位晚于最后一笔盈亏):删 halt 恢复后不被同一段历史再次熔断
  assert.equal(lossHaltTripped({ ...cache, _lossHaltAt: "2026-07-04" }, 3).tripped, false);
  // 水位后有新亏损落地:再次熔断
  assert.equal(
    lossHaltTripped({ ...cache, _lossHaltAt: "2026-07-02T12:00", c3: { at: "2026-07-03", pnlUsd: -30 } }, 3).tripped,
    true
  );
  // 盈亏未知的记录不稀释计数(consecutiveLossTail 语义透传)
  assert.equal(lossHaltTripped({ ...cache, c4: { at: "2026-07-04", notified: false } }, 3).tripped, true);
});

// ── 预告模板家族三闸门(2026-07-14 官方行为研究 §7.2)──
// 重放 15 个月:三闸门 16 笔全胜 +$194,无闸裸执行 −$195(快照雷全踩)。
// 闸门全部在任何网络调用之前,可离线断言;EXEC_WALLET_JSON 指向不存在路径,
// 保证"过闸"用例在 client init 处以 error 终止,绝不触网。
import { executeSignal } from "../lib/polymarket/tradeExecutor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORECAST_SIGNAL = {
  qid: "0xq",
  tokenId: "1234",
  conditionId: "0xc",
  outcome: "Yes",
  question: "gate test?",
  marketUrl: null,
  label: "🟢 双确认 YES·high",
  stance: "YES",
  llmStance: "YES",
  llmConfidence: "high",
  llmEventStatus: "decided",
  bestAskAtSignal: 0.55,
  forecastTemplate: true,
  budgetMs: 60_000,
};

async function execWith(
  env: Record<string, string>,
  input: Partial<Parameters<typeof executeSignal>[0]>
) {
  const dir = mkdtempSync(join(tmpdir(), "prededge-gate-"));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    EXEC_MODE: "live",
    EXEC_LEDGER: join(dir, "ledger.jsonl"),
    EXEC_HALT_FILE: join(dir, "halt-absent"),
    EXEC_WALLET_JSON: join(dir, "wallet-absent.json"),
    EXEC_SKIP_FORECAST_TEMPLATE: "",
    EXEC_FORECAST_LIVE: "",
    ...env,
  };
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await executeSignal({ ...FORECAST_SIGNAL, ...input });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("预告家族:EXEC_SKIP_FORECAST_TEMPLATE=on 恢复旧一刀切 skip", async () => {
  const r = await execWith({ EXEC_SKIP_FORECAST_TEMPLATE: "on" }, {});
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /EXEC_SKIP_FORECAST_TEMPLATE=on/);
});

test("预告家族闸1 boundary:leans∧事件未决 → 拦截(llm 侧与正则侧都看)", async () => {
  const viaLlm = await execWith({}, { llmStance: "leans_YES", llmEventStatus: "pending" });
  assert.equal(viaLlm.status, "skipped");
  assert.match(viaLlm.reason ?? "", /boundary闸/);
  const viaRegex = await execWith({}, { stance: "leans_NO", llmStance: "NO", llmEventStatus: "pending" });
  assert.match(viaRegex.reason ?? "", /boundary闸/);
  // decided 时 leans 不触发 boundary 闸(掉到下一道闸)
  const decided = await execWith({}, { llmStance: "leans_YES", llmEventStatus: "decided" });
  assert.doesNotMatch(decided.reason ?? "", /boundary闸/);
});

test("预告家族闸1 fail-closed(2026-07-19 §10):eventStatus null/unclear ∧ leans 同样拦截", async () => {
  // null 是 llmStance 设计内状态(v3 回复/字段缺失)—— 修复前 === "pending" 对它放行
  const nullEs = await execWith({}, { llmStance: "leans_YES", llmEventStatus: null as unknown as string });
  assert.equal(nullEs.status, "skipped");
  assert.match(nullEs.reason ?? "", /boundary闸/);
  const unclear = await execWith({}, { llmStance: "leans_YES", llmEventStatus: "unclear" });
  assert.equal(unclear.status, "skipped");
  assert.match(unclear.reason ?? "", /boundary闸/);
  // 非 leans 的确定方向 ∧ eventStatus 未知:不触发 boundary 闸
  const firm = await execWith({}, { llmStance: "YES", stance: "YES", llmEventStatus: null as unknown as string });
  assert.doesNotMatch(firm.reason ?? "", /boundary闸/);
});

test("预告家族闸2 防雷:方向侧信号价 <0.30 → 不执行;非预告家族不受此闸", async () => {
  const r = await execWith({}, { bestAskAtSignal: 0.22 });
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /防雷闸/);
  // 同价位的非预告家族信号不触发防雷闸(走到钱包缺失的 error = 已过全部风控闸)
  const normal = await execWith({}, { bestAskAtSignal: 0.22, forecastTemplate: false });
  assert.doesNotMatch(normal.reason ?? "", /防雷闸/);
});

test("预告家族 paper 验证期:三闸门通过后 live 不实弹(EXEC_FORECAST_LIVE 默认 off)", async () => {
  const r = await execWith({}, {});
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /paper 验证期/);
});

test("预告家族 EXEC_FORECAST_LIVE=on:过闸放行,推进到 client init(此处按缺钱包 error 终止)", async () => {
  const r = await execWith({ EXEC_FORECAST_LIVE: "on" }, {});
  assert.equal(r.status, "error");
  assert.doesNotMatch(r.reason ?? "", /预告|boundary闸|防雷闸|paper 验证期/);
});

test("预告家族 dry 模式:闸门语义一致,paper skip 只拦 live 不拦 dry", async () => {
  const r = await execWith({ EXEC_MODE: "dry" }, {});
  // dry 过三闸门后继续全链路(client init 因缺钱包 error)——线上演练路径可用
  assert.equal(r.status, "error");
  assert.doesNotMatch(r.reason ?? "", /paper 验证期/);
});

// ── bestAskAtSignal=null 双口径(2026-08-01 飓风家族复盘)──
// 空盘(bookEmpty)= CLOB book 全镜像下任何价位无 taker 对手盘,人工也无从
// 下单,skip 文案不再误导性喊人工;仅注解异常口径才请求人工核对。

test("无基准 skip:bookEmpty=true → 空盘口径(不喊人工下单)", async () => {
  const r = await execWith({}, { bestAskAtSignal: null, bookEmpty: true, forecastTemplate: false });
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /空盘/);
  assert.match(r.reason ?? "", /maker/);
  assert.doesNotMatch(r.reason ?? "", /人工确认后手动下单/);
  assert.equal(r.subjectAlert, "空盘不可成交");
});

test("无基准 skip:bookEmpty 缺省/false → 注解异常口径(请求人工核对)", async () => {
  const r = await execWith({}, { bestAskAtSignal: null, forecastTemplate: false });
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /无盘口基准/);
  assert.match(r.reason ?? "", /人工确认后手动下单/);
  assert.equal(r.subjectAlert, "无盘口基准");
  const explicit = await execWith({}, { bestAskAtSignal: null, bookEmpty: false, forecastTemplate: false });
  assert.match(explicit.reason ?? "", /无盘口基准/);
});
