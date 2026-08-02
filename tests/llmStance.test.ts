/**
 * 2026-08-02 xhigh 审计 finding 5 回归:重试预算与单次超时的切分。
 * 缺陷形态 —— perAttempt 与整轮 deadline 共用同一个数(生产 60s):第一次
 * 尝试若以超时告终(代理半开挂死,正是这套重试针对的主形态)就把预算一次
 * 用光,下一轮开头 leftMs≈0 直接 break,maxTries=3 实跑 1 次,日志还打
 * "after 3 tries"。全部断言离线:纯函数 + 一条预算耗尽的短路径(在任何
 * runClaude 调用之前返回,CLAUDE_BIN 不会被执行)。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  perAttemptTimeoutMs,
  LLM_MIN_ATTEMPT_MS,
  LLM_RETRY_MIN_LEFT_MS,
  llmCliCallCount,
  classifyStanceWithLlm,
} from "../lib/polymarket/llmStance";

test("finding 5:单次超时按 maxTries 均分总预算 —— 一次打满的失败之后仍留得下重试", () => {
  // 生产口径 LLM_STANCE_TIMEOUT_MS=60s / LLM_STANCE_MAX_TRIES=3
  assert.equal(perAttemptTimeoutMs(60_000, 3), 20_000);
  // 这条才是缺陷本身:修复前 perAttempt === 总预算 → 剩余 0 < 地板 → 循环
  // 第二轮直接 break,"重试"从来没有真的发生过。
  assert.ok(
    60_000 - perAttemptTimeoutMs(60_000, 3) >= LLM_RETRY_MIN_LEFT_MS,
    "一次打满单次超时后,剩余预算必须仍越过重试地板"
  );
  // 预算更大时按份均分(仍是"能跑满 maxTries 次"的形状)
  assert.equal(perAttemptTimeoutMs(90_000, 3), 30_000);
  assert.equal(perAttemptTimeoutMs(120_000, 4), 30_000);
  assert.ok(120_000 - 2 * perAttemptTimeoutMs(120_000, 4) >= LLM_RETRY_MIN_LEFT_MS);
});

test("finding 5:下限托底与总预算夹取 —— 小预算退化为单次尝试,不切无效片", () => {
  // 45s/3=15s 低于实测典型调用(5-9s)的安全余量 → 抬到 20s 下限(仍 ≤ 总预算)
  assert.equal(perAttemptTimeoutMs(45_000, 3), LLM_MIN_ATTEMPT_MS);
  // 调用方 wallBudget 把总预算压到 15s:均分得 5s 的无效片,托底后被夹回总
  // 预算 —— 退化成"一次尝试用满预算",绝不造出比预算还短的切片。
  assert.equal(perAttemptTimeoutMs(15_000, 3), 15_000);
  assert.ok(
    15_000 - perAttemptTimeoutMs(15_000, 3) < LLM_RETRY_MIN_LEFT_MS,
    "退化档下第二轮 leftMs 必须落在地板以下(单次尝试)"
  );
  assert.equal(perAttemptTimeoutMs(8_000, 3), 8_000);
  // maxTries=1:切片 = 总预算
  assert.equal(perAttemptTimeoutMs(60_000, 1), 60_000);
  // 防御性:maxTries=0/负数不得产生 Infinity/NaN 切片
  assert.equal(perAttemptTimeoutMs(60_000, 0), 60_000);
});

test("finding 5:预算不足以发起首次调用时,告警报真实尝试数(不再恒打 maxTries)", async () => {
  // 总预算 1s < 重试地板 → 循环第一轮就 break,runClaude 一次都不发起
  // (CLAUDE_BIN 不会被执行,零子进程/零网络)。
  const dir = mkdtempSync(join(tmpdir(), "prededge-llm-"));
  const saved = {
    cache: process.env.LLM_STANCE_CACHE,
    stance: process.env.LLM_STANCE,
    tries: process.env.LLM_STANCE_MAX_TRIES,
    bin: process.env.CLAUDE_BIN,
  };
  process.env.LLM_STANCE_CACHE = join(dir, "cache.json");
  delete process.env.LLM_STANCE;
  process.env.LLM_STANCE_MAX_TRIES = "3";
  process.env.CLAUDE_BIN = join(dir, "claude-absent"); // 真被调用会 ENOENT,断言里能看出来
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  const before = llmCliCallCount();
  try {
    const r = await classifyStanceWithLlm({
      title: "gate test",
      updates: [{ timestamp: 1, iso: "2026-08-02T00:00:00Z", text: "official clarification text" }],
      regexStance: { stance: "none", confidence: "low" },
      cacheKey: "qtest:1",
      timeoutMs: 1_000,
    });
    assert.equal(r, null);
  } finally {
    console.warn = origWarn;
    for (const [k, v] of Object.entries({
      LLM_STANCE_CACHE: saved.cache,
      LLM_STANCE: saved.stance,
      LLM_STANCE_MAX_TRIES: saved.tries,
      CLAUDE_BIN: saved.bin,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(llmCliCallCount(), before, "预算不足时不得发起任何 CLI 调用");
  const failLine = warns.find((w) => w.includes("claude CLI call failed"));
  assert.ok(failLine, `应有失败告警,实得: ${warns.join(" | ")}`);
  // 修复前恒打 "after 3 tries" —— 掩盖"其实一次都没发起"
  assert.match(failLine!, /after 0\/3 tries/);
  assert.match(failLine!, /budget exhausted before first attempt/);
  assert.doesNotMatch(failLine!, /before retry/);
});
