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
  limitPriceFor,
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
import { mkdtempSync, writeFileSync } from "node:fs";
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

// ── 2026-08-02 复盘批:补仓额度 / 同事件聚合帽 / 宣告扫单限价 ──

test("限价帽:普通 🟢 用绝对滑点带,宣告类按边缩放放宽", () => {
  const cfg = { slippage: 0.03, slippageEdgeFrac: 0.15, maxPrice: 0.97 };
  // 0.66:普通 = 0.66+0.03 = 0.69;宣告 = 0.66 + max(0.03, 0.15×0.34=0.051) = 0.711 → 0.71
  assert.equal(limitPriceFor(0.66, false, cfg), 0.69);
  assert.equal(limitPriceFor(0.66, true, cfg), 0.71);
  // 高价位:边缩放退化回绝对带,两者一致(只放宽低价位,绝不收紧既有行为)
  assert.equal(limitPriceFor(0.9, false, cfg), 0.93);
  assert.equal(limitPriceFor(0.9, true, cfg), 0.93);
  // maxPrice 与 0.99 硬帽在两种口径下都不被突破
  assert.equal(limitPriceFor(0.96, true, cfg), 0.97);
  // 0.5 + max(0.03, 0.15×0.5=0.075) = 0.575,但 0.575×100 在双精度下是
  // 57.4999…,Math.round 落到 57 → 0.57。这是既有 round(x*100)/100 惯用法的
  // 浮点边界,方向是"少付一个 tick"(保守),刻意不改:改成向上取整会在所有
  // 现存路径上普涨限价。
  assert.equal(limitPriceFor(0.5, true, { ...cfg, maxPrice: 0.99 }), 0.57);
});

test("补仓:token 累计敞口未达上限 → 不再二值封锁(可继续加仓)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-refill-"));
  const ledger = join(dir, "ledger.jsonl");
  // 已成交 $47(与 2026-07-28 实盘同形态),per-token 上限 $100 → 还剩 $53
  writeFileSync(
    ledger,
    JSON.stringify({
      at: "2026-07-28T21:21:53.718Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "filled", posted: true, requestedUsd: 47, filledUsd: 47,
    }) + "\n"
  );
  const r = await execWith(
    { EXEC_LEDGER: ledger, EXEC_PER_TOKEN_MAX_USD: "100", EXEC_MAX_ORDER_USD: "100" },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false }
  );
  // 过了去重闸(否则会是 skipped/累计敞口已满);此处按缺钱包 error 终止
  assert.notEqual(r.status, "skipped");
  assert.doesNotMatch(r.reason ?? "", /累计敞口已满|已对该 token 执行过/);
});

test("补仓:token 累计敞口达上限 → skip 并说明是敞口口径(不是旧的二值封锁)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-refill2-"));
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(
    ledger,
    JSON.stringify({
      at: "2026-07-28T21:21:53.718Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "filled", posted: true, requestedUsd: 47, filledUsd: 47,
    }) + "\n"
  );
  // 零网络的真正理由(2026-08-02 三轮复查:只改注释,断言与参数值一律不动)。
  // 旧注释写的是"budgetMs=14s 让 openExposureUsd 首轮 break",第二轮把 per-token 帽上
  // 那一跳 Gamma 撤掉之后就不成立了:该闸现在是纯本地缓存读(tradeExecutor.ts:924
  // loadSettledCache,单次小文件,无网络),且本用例命中的 return(:957 finish skipped)
  // 位于 totalMax 那个块(:1002-1031)**之前** —— openExposureUsd 在这条路径上根本不可达,
  // 零网络与 budgetMs 无关。
  // budgetMs=14_000 仍保留,作用是纵深钉住另一条路径:万一日后调闸门顺序/阈值让流程走到
  // totalMax 那块,其探测预算 = min(12s, budgetMs−15s) ≤ 0,openExposureUsd 首轮即 break
  // (:522 deadline 判断),套件"闸门断言绝不触网"的前提照样成立。
  // 两个坑别踩:① 别按旧注释推断 per-token 会打网络;② 别因为"看着没用"删掉这个参数。
  // 下界也是硬的:14_000 不能降到 12_000 以下,否则被 :789 的"tick 预算不足"前置闸提前
  // 拦掉,本用例断的就不再是敞口闸了。
  const r = await execWith(
    { EXEC_LEDGER: ledger, EXEC_PER_TOKEN_MAX_USD: "40" },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false, budgetMs: 14_000 }
  );
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /累计敞口已满/);
});

test("同事件聚合帽:兄弟腿共享 eventId,合计触顶即拦(单笔/单日闸拦不住的口径)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-event-"));
  const ledger = join(dir, "ledger.jsonl");
  // 同一事件下两条已成交的兄弟腿,合计 $150
  writeFileSync(
    ledger,
    [
      JSON.stringify({ at: "2026-07-28T21:00:00.000Z", qid: "qa", tokenId: "tok-a", conditionId: "ca", eventId: "744619", mode: "live", status: "filled", posted: true, filledUsd: 80 }),
      JSON.stringify({ at: "2026-07-28T21:05:00.000Z", qid: "qb", tokenId: "tok-b", conditionId: "cb", eventId: "744619", mode: "live", status: "filled", posted: true, filledUsd: 70 }),
    ].join("\n") + "\n"
  );
  const r = await execWith(
    { EXEC_LEDGER: ledger, EXEC_PER_EVENT_MAX_USD: "150", EXEC_DAILY_MAX_USD: "1000", EXEC_TOTAL_MAX_USD: "5000" },
    { tokenId: "tok-c", conditionId: "cc", eventId: "744619", forecastTemplate: false }
  );
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /同事件聚合敞口已满/);
  assert.equal(r.subjectAlert, "同事件敞口满");
  // 不同事件的腿不受此闸约束
  const other = await execWith(
    { EXEC_LEDGER: ledger, EXEC_PER_EVENT_MAX_USD: "150", EXEC_DAILY_MAX_USD: "1000", EXEC_TOTAL_MAX_USD: "5000" },
    { tokenId: "tok-d", conditionId: "cd", eventId: "999999", forecastTemplate: false }
  );
  assert.doesNotMatch(other.reason ?? "", /同事件聚合敞口已满/);
});

// ── 2026-08-02 xhigh 审计:finding 9(per-token 结算核销)/ finding 13(dry 封锁)──

test("finding 9:per-token 帽做结算核销 —— 毛额触顶但已结算 → 放行(不再终身封死)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-pertoken-settled-"));
  const ledger = join(dir, "ledger.jsonl");
  // 该 token 终身毛额 $100 = per-token 上限:修复前 exposedUsd 单调不减,
  // 一次吃满就永久 skip(与刚被替换掉的二值封锁等价)。
  writeFileSync(
    ledger,
    JSON.stringify({
      at: "2026-07-28T21:21:53.718Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "filled", posted: true, requestedUsd: 100, filledUsd: 100,
    }) + "\n"
  );
  // 结算缓存 = openExposureUsd 内部同一份文件(ledger 同目录 trade-settled.json)。
  // c1 已终局(带 pnl)→ 钱早已回款,净敞口 $0,零网络即可核销。
  writeFileSync(
    join(dir, "trade-settled.json"),
    JSON.stringify({ c1: { at: "2026-07-30T00:00:00.000Z", pnlUsd: 12, notified: true } })
  );
  const r = await execWith(
    {
      EXEC_LEDGER: ledger, EXEC_PER_TOKEN_MAX_USD: "100", EXEC_MAX_ORDER_USD: "100",
      EXEC_DAILY_MAX_USD: "1000", EXEC_TOTAL_MAX_USD: "5000",
    },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false }
  );
  // 过闸(此处按缺钱包 error 终止);修复前是 skipped「累计敞口已满」
  assert.notEqual(r.status, "skipped");
  assert.doesNotMatch(r.reason ?? "", /累计敞口已满/);
});

test("finding 9:核销只放宽不放大 —— 未结算的同额敞口仍触顶,文案带净/毛双口径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-pertoken-open-"));
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(
    ledger,
    JSON.stringify({
      at: "2026-07-28T21:21:53.718Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "filled", posted: true, requestedUsd: 100, filledUsd: 100,
    }) + "\n"
  );
  // trade-settled.json 不存在 = 该持仓仍在险中,缓存未知按 fail-closed 计,故净=毛。
  // 零网络同上一用例(2026-08-02 三轮复查:只改注释,断言与参数值一律不动):per-token 帽
  // 第二轮起是纯缓存读,且这条 skip 的 return 在 totalMax 块之前,openExposureUsd 不可达;
  // budgetMs=14_000 保留为纵深(让 totalMax 那条路径的探测预算 ≤0 同样不触网),且必须
  // ≥12_000 以免被 tradeExecutor.ts:789 的"tick 预算不足"前置闸抢先拦下。
  const r = await execWith(
    {
      EXEC_LEDGER: ledger, EXEC_PER_TOKEN_MAX_USD: "100", EXEC_MAX_ORDER_USD: "100",
      EXEC_DAILY_MAX_USD: "1000", EXEC_TOTAL_MAX_USD: "5000",
    },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false, budgetMs: 14_000 }
  );
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /累计敞口已满/); // gonogo bucketOf 按此词干归"额度闸"
  assert.match(r.reason ?? "", /净 \$100\/100/);
  assert.match(r.reason ?? "", /毛额 \$100/);
});

test("finding 13:dry 模式被已有实盘敞口封锁(不重复构单)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-drydup-"));
  const ledger = join(dir, "ledger.jsonl");
  // 实盘已持 $20(远低于 per-token 上限,live 侧本可继续补仓)
  writeFileSync(
    ledger,
    JSON.stringify({
      at: "2026-07-28T21:21:53.718Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "filled", posted: true, requestedUsd: 20, filledUsd: 20,
    }) + "\n"
  );
  const r = await execWith(
    { EXEC_MODE: "dry", EXEC_LEDGER: ledger, EXEC_PER_TOKEN_MAX_USD: "100", EXEC_MAX_ORDER_USD: "100" },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false }
  );
  // 修复前 dry 分支只匹配旧 dry 行,live 持仓对 dry 不可见 → 照常构单并发
  // "已构单"的 dry 邮件,读信人看不到「已有持仓」这个关键上下文。
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /已有实盘敞口/);
  assert.equal(r.subjectAlert, "已持仓$20");
});

test("finding 13 边界:旧 dry 行仍走原文案;零敞口的 live 行不封锁 dry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-drydup2-"));
  // (a) 只有旧 dry 行 → 原「已对该 token 执行过」语义不变
  const dryLedger = join(dir, "dry.jsonl");
  writeFileSync(
    dryLedger,
    JSON.stringify({
      at: "2026-07-28T21:00:00.000Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "dry", status: "dry", posted: false, requestedUsd: 20,
    }) + "\n"
  );
  const a = await execWith(
    { EXEC_MODE: "dry", EXEC_LEDGER: dryLedger },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false }
  );
  assert.equal(a.status, "skipped");
  assert.match(a.reason ?? "", /已对该 token 执行过/);
  assert.doesNotMatch(a.reason ?? "", /已有实盘敞口/);
  // (b) live 行零成交(posted=true 但无 filledUsd,exposedUsd=0)→ 不封锁:
  // 一次 FAK 无对手盘不该让 dry 演练路径对该 token 失明。
  const noFillLedger = join(dir, "nofill.jsonl");
  writeFileSync(
    noFillLedger,
    JSON.stringify({
      at: "2026-07-28T21:00:00.000Z", qid: "q1", tokenId: "tok-1", conditionId: "c1",
      mode: "live", status: "none", posted: true, requestedUsd: 50,
    }) + "\n"
  );
  const b = await execWith(
    { EXEC_MODE: "dry", EXEC_LEDGER: noFillLedger },
    { tokenId: "tok-1", conditionId: "c1", forecastTemplate: false }
  );
  assert.notEqual(b.status, "skipped");
  assert.doesNotMatch(b.reason ?? "", /已有实盘敞口|已对该 token 执行过/);
});

test("eventId 缺失时同事件帽不生效(不阻断没有事件归属的信号)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prededge-event2-"));
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(
    ledger,
    JSON.stringify({ at: "2026-07-28T21:00:00.000Z", qid: "qa", tokenId: "tok-a", conditionId: "ca", eventId: "744619", mode: "live", status: "filled", posted: true, filledUsd: 300 }) + "\n"
  );
  const r = await execWith(
    { EXEC_LEDGER: ledger, EXEC_PER_EVENT_MAX_USD: "150", EXEC_DAILY_MAX_USD: "1000", EXEC_TOTAL_MAX_USD: "5000" },
    { tokenId: "tok-z", conditionId: "cz", forecastTemplate: false }
  );
  assert.doesNotMatch(r.reason ?? "", /同事件聚合敞口已满/);
});
