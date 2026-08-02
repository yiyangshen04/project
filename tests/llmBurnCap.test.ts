/**
 * N1 回归(2026-08-02 三轮复查):瞬断墙钟硬帽,以及它与 chain-watch 三条下游
 * 门限的定量关系。
 *
 * 缺陷形态:二轮把 LLM_DISABLE_AFTER_FAILED_KEYS 从 1 提到 2 是对的(一个病态
 * prompt 不该掐掉整个 tick 的判读),但副作用是把瞬断期间烧掉的墙钟**翻倍** ——
 * "证明线路死"需要两个不同事件各自重试耗尽,每个耗尽 ≈ 一整份 timeoutMs。
 * 生产常量下(LLM_STANCE_TIMEOUT_MS=60s / MAX_TRIES=3 / BACKOFF=1.5s):
 *   20s + 1.5s + 20s + 1.5s + 17s = 60,000ms / 事件 → 门槛 2 就是 120,000ms,
 * 而一个 tick 的墙钟预算只有 158,000ms(TICK_KILL_MS 170,000 −
 * SEND_MARGIN_MS 12,000)。剩 38,000ms,下游被逐条击穿 —— 最要命的是
 * sweepRefillQueue 的 45,000ms 门限,本批的头号功能"补仓窗口"在整个断供期间
 * 每个 tick 都不跑。
 * 修法:第三条闸是墙钟而非次数 —— 不论几个事件作证,瞬断一共只能烧掉
 * LLM_TRANSIENT_BURN_SHARES(=1)份 timeoutMs,触顶即停判读。
 *
 * 单独成文件的原因(同 tests/llmGate.test.ts):transientBurnMs / burnCapWarned /
 * exhaustedKeys 都是模块级进程状态,而 node:test 每个测试文件跑在独立子进程里。
 * 混进别的文件会与那里的用例共享账本,断言变成顺序耦合。
 *
 * 离线性:①③ 是纯函数,零 IO。② 走真实 classifyStanceWithLlm,失败注入是本地
 * 临时目录里一个 3 行 sh 脚本(立刻 exit 1),不触网;并把 LLM_STANCE_TIMEOUT_MS
 * 压到 6s,使"任何非零瞬断耗时都触顶",用例毫秒级跑完 —— 帽子的机制与生产
 * 逐字相同,只是刻度不同;生产刻度由 ①③ 用真实常量锁死。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  llmBurnGate,
  perAttemptTimeoutMs,
  resetLlmTransientBurn,
  llmTransientBurnMs,
  llmCliCallCount,
  classifyStanceWithLlm,
  LLM_TRANSIENT_BURN_SHARES,
  LLM_MIN_ATTEMPT_MS,
  LLM_RETRY_MIN_LEFT_MS,
} from "../lib/polymarket/llmStance";

// ── 生产口径的对侧常量 ──
// scripts/chain-watch.ts 是脚本(文件底部无条件 main()),import 会真的跑一个
// tick,所以这里只能抄常量。抄的每一条都注明出处行,改动时一起改。
const TICK_KILL_MS = 170_000; // chain-watch.ts:229 run-cron.sh 的 timeout SIGTERM
const SEND_MARGIN_MS = 12_000; // chain-watch.ts:231 sendMail+commitState 的尾部余量
const TICK_WALL_MS = TICK_KILL_MS - SEND_MARGIN_MS; // = 158_000,一个 tick 真正可用的墙钟
const SWEEP_REFILL_GATE_MS = 45_000; // chain-watch.ts:1975 补仓窗口的早停门限
const RECONCILE_GATE_MS = 25_000; // chain-watch.ts:2268 结算对账的早停门限
const EXECUTE_SIGNAL_GATE_MS = 12_000; // tradeExecutor.ts:789 「tick 预算不足」skip 闸
const ENV_TIMEOUT_MS = 60_000; // 生产 LLM_STANCE_TIMEOUT_MS
const MAX_TRIES = 3; // 生产 LLM_STANCE_MAX_TRIES
const BACKOFF_MS = 1_500; // 生产 LLM_STANCE_RETRY_BACKOFF_MS

test("N1:瞬断硬帽必须给三条下游门限留得下预算(帽子一放大就击穿补仓窗口)", () => {
  const capMs = LLM_TRANSIENT_BURN_SHARES * ENV_TIMEOUT_MS;
  // 帽是闭合上界而非近似:allowanceMs = 帽 − 账本 同时是 timeoutMs 的夹取上界,
  // 单次调用的 burnedMs 受自己的 deadline 约束 ≤ allowanceMs,故账本恒 ≤ 帽。
  // 于是"LLM 阶段之后至少还剩多少"与失败形态无关,可以直接算。
  const worstLeftMs = TICK_WALL_MS - capMs;

  // 这三条才是本用例的目的。任何一条不满足,断供期间对应的功能就整段停摆。
  assert.ok(
    worstLeftMs >= SWEEP_REFILL_GATE_MS,
    `补仓窗口会被击穿:LLM 最坏烧 ${capMs}ms,tick 只剩 ${worstLeftMs}ms < ${SWEEP_REFILL_GATE_MS}ms`
  );
  assert.ok(
    worstLeftMs >= RECONCILE_GATE_MS,
    `结算对账会被击穿:只剩 ${worstLeftMs}ms < ${RECONCILE_GATE_MS}ms`
  );
  assert.ok(
    worstLeftMs >= EXECUTE_SIGNAL_GATE_MS,
    `真 🟢 信号会被记成「tick 预算不足」skip:只剩 ${worstLeftMs}ms < ${EXECUTE_SIGNAL_GATE_MS}ms`
  );

  // 最紧的一条(补仓)还剩多少余量给本 tick 的其余工作(RPC 扫链/enrich/发信)。
  // 缺陷版(帽=2 份=120,000ms)这里是 −7,000ms —— 无论 tick 多空闲都必然击穿。
  assert.equal(worstLeftMs - SWEEP_REFILL_GATE_MS, 53_000);
});

test("N1:生产常量下一个事件恰好烧满一份预算 —— 第 2 个事件就必须触帽", () => {
  const capMs = LLM_TRANSIENT_BURN_SHARES * ENV_TIMEOUT_MS;

  // 一次"全部尝试都超时"的调用的墙钟排程(与 classifyStanceWithLlm 的循环同构,
  // 全部因子都来自被测模块的导出常量,不是抄来的数):
  //   尝试(perAttempt) → 退避 → 尝试 → 退避 → 尾次被 deadline 夹短
  const perAttempt = perAttemptTimeoutMs(ENV_TIMEOUT_MS, MAX_TRIES);
  assert.equal(perAttempt, 20_000);
  const beforeLastTry = 2 * perAttempt + 2 * BACKOFF_MS; // 43,000
  const lastTry = ENV_TIMEOUT_MS - beforeLastTry; // 17,000 —— 被 deadline 夹短
  assert.ok(lastTry >= LLM_RETRY_MIN_LEFT_MS, "尾次尝试仍越得过重试地板,确实会发起");
  const exhaustedBurnMs = beforeLastTry + lastTry;
  assert.equal(exhaustedBurnMs, 60_000, "一个事件重试耗尽 = 恰好一整份 timeoutMs");

  // 逐事件走帽:5 条 llmPending 的断供 tick。
  let ledger = 0;
  const table: Array<{ k: number; burn: number; cum: number; blocked: boolean }> = [];
  for (let k = 1; k <= 5; k += 1) {
    const { blocked, allowanceMs } = llmBurnGate(ledger, capMs);
    // 触帽的事件一分墙钟都不烧(在任何 execFile 之前 return);未触帽的按排程烧,
    // 且被 allowanceMs 夹住 —— 这一夹取正是"总烧 ≤ 一份"的闭合保证。
    const burn = blocked ? 0 : Math.min(exhaustedBurnMs, allowanceMs);
    ledger += burn;
    table.push({ k, burn, cum: ledger, blocked });
  }

  assert.deepEqual(table, [
    { k: 1, burn: 60_000, cum: 60_000, blocked: false },
    { k: 2, burn: 0, cum: 60_000, blocked: true },
    { k: 3, burn: 0, cum: 60_000, blocked: true },
    { k: 4, burn: 0, cum: 60_000, blocked: true },
    { k: 5, burn: 0, cum: 60_000, blocked: true },
  ]);
  assert.ok(ledger <= capMs, "账本恒不越帽");
  // 触帽后整个 tick 还剩下的墙钟,以及它对最紧的一条门限的余量。
  assert.equal(TICK_WALL_MS - ledger, 98_000);
  assert.ok(TICK_WALL_MS - ledger >= SWEEP_REFILL_GATE_MS);
});

test("N1:防误配自锁 —— 账本为零时绝不关闸(帽比一次最小尝试还小也一样)", () => {
  // 帽 < LLM_MIN_ATTEMPT_MS 是误配形态(有人把 LLM_STANCE_TIMEOUT_MS 调很小)。
  // 没有 `ledgerMs > 0` 这半个条件,一次瞬断都还没发生就把本 tick 判读全关掉。
  const tiny = 6_000;
  assert.ok(tiny < LLM_MIN_ATTEMPT_MS);
  assert.equal(llmBurnGate(0, tiny).blocked, false, "零账本不许关闸");
  assert.equal(llmBurnGate(1, tiny).blocked, true, "真烧过墙钟之后这道闸才生效");
  // 正常刻度下,健康 tick(零瞬断)同样不受影响。
  assert.equal(llmBurnGate(0, 60_000).blocked, false);
  // 烧过一点点、余量仍够一次最小尝试 → 继续判读,不因一次快失败就停摆。
  assert.equal(llmBurnGate(200, 60_000).blocked, false);
  assert.equal(llmBurnGate(60_000 - LLM_MIN_ATTEMPT_MS, 60_000).blocked, false, "余量恰好等于下限 → 放行");
  assert.equal(llmBurnGate(60_000 - LLM_MIN_ATTEMPT_MS + 1, 60_000).blocked, true, "余量差 1ms → 关闸");
});

/** 立刻失败的假 CLI(瞬断口径:stderr 文案避开 isTerminalLlmFailure 的全部词)。
 * `cat >/dev/null` 吃掉 stdin 上的 prompt,免得子进程早退触发 EPIPE 改变失败形态。 */
function makeTransientFailingCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "prededge-burncap-"));
  const bin = join(dir, "fake-claude");
  writeFileSync(
    bin,
    '#!/bin/sh\ncat >/dev/null\necho "proxy CONNECT tunnel failure: 502 Bad Gateway" >&2\nexit 1\n'
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("N1 真实路径:触帽后的事件在任何 execFile 之前短路,且告警只打一次", async () => {
  const saved = {
    bin: process.env.CLAUDE_BIN,
    cache: process.env.LLM_STANCE_CACHE,
    stance: process.env.LLM_STANCE,
    timeout: process.env.LLM_STANCE_TIMEOUT_MS,
    tries: process.env.LLM_STANCE_MAX_TRIES,
    backoff: process.env.LLM_STANCE_RETRY_BACKOFF_MS,
  };
  const dir = mkdtempSync(join(tmpdir(), "prededge-burncap-cache-"));
  process.env.CLAUDE_BIN = makeTransientFailingCli();
  process.env.LLM_STANCE_CACHE = join(dir, "cache.json");
  delete process.env.LLM_STANCE;
  // 帽 = 1 × 6,000ms < LLM_MIN_ATTEMPT_MS(20,000)⇒ 任何非零瞬断耗时都触顶。
  // 生产是 60,000ms 烧满才触顶,机制逐字相同、只是刻度不同(生产刻度见上面
  // 三条纯函数用例)—— 这样用例毫秒级跑完,不用真等 60 秒。
  process.env.LLM_STANCE_TIMEOUT_MS = "6000";
  process.env.LLM_STANCE_MAX_TRIES = "1";
  process.env.LLM_STANCE_RETRY_BACKOFF_MS = "0";
  resetLlmTransientBurn();
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const call = (cacheKey: string) =>
      classifyStanceWithLlm({
        title: "burn cap",
        updates: [{ timestamp: 1, iso: "2026-08-02T00:00:00Z", text: "official clarification text" }],
        regexStance: { stance: "none", confidence: "low" },
        cacheKey,
        timeoutMs: 6_000,
      });

    // ① 第一个事件:账本为零,必须照常发起调用(防误配自锁那半个条件)。
    const c0 = llmCliCallCount();
    assert.equal(await call("qA:1"), null);
    assert.equal(llmCliCallCount(), c0 + 1, "第一个事件应真的发起过 CLI 调用");
    const burnedByFirst = llmTransientBurnMs();
    assert.ok(burnedByFirst > 0, "失败尝试的墙钟必须记进账本");

    // ② 之后每个事件都触帽:零 CLI 调用、零新增账本。缺陷版(无硬帽)这里会
    //    继续逐个事件各烧一份预算 —— 正是要消灭的 120s 形态。
    for (const key of ["qB:1", "qC:1", "qD:1", "qE:1"]) {
      assert.equal(await call(key), null);
      assert.equal(llmCliCallCount(), c0 + 1, `${key} 触帽后不得再发起任何 CLI 调用`);
      assert.equal(llmTransientBurnMs(), burnedByFirst, `${key} 触帽后账本不得再涨`);
    }

    // ③ 触顶告警是状态迁移,只打一次;文案要与 disabledThisProcess 的两条可区分。
    const capLines = warns.filter((w) => w.includes("累计瞬断耗时触顶"));
    assert.equal(capLines.length, 1, `触顶告警应只打一次,实得 ${capLines.length} 条`);
    assert.match(capLines[0], /本 tick 停判读/);
    assert.match(capLines[0], /自 qB:1 起/, "应点名是从哪个事件开始降级");
  } finally {
    console.warn = origWarn;
    resetLlmTransientBurn();
    for (const [k, v] of Object.entries({
      CLAUDE_BIN: saved.bin,
      LLM_STANCE_CACHE: saved.cache,
      LLM_STANCE: saved.stance,
      LLM_STANCE_TIMEOUT_MS: saved.timeout,
      LLM_STANCE_MAX_TRIES: saved.tries,
      LLM_STANCE_RETRY_BACKOFF_MS: saved.backoff,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
