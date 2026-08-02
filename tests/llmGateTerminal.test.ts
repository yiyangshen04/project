/**
 * R10 的另一半(2026-08-02 复查):把瞬断的爆炸半径收窄到"两个不同事件"之后,
 * **终局故障必须仍然第一次就关闸**。未登录/CLI 缺失/参数不被接受时重试确实毫无
 * 意义 —— 每个事件白烧一整份 timeoutMs,一个 tick 的判读预算就这么没了
 * (2026-07-27/28 两次真断供 17h + 3h 就是这个形态)。
 *
 * 单独成文件的理由同 tests/llmGate.test.ts:disabledThisProcess 是模块级进程
 * 状态,而 node:test 每个文件一个子进程。这条要断言"第一次就关",必须拿到一个
 * 干净的闸门。
 * 离线:CLAUDE_BIN 指向本地临时 sh 脚本,不触网。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStanceWithLlm, llmCliCallCount } from "../lib/polymarket/llmStance";

const UPDATES = [
  { timestamp: 1, iso: "2026-08-02T00:00:00Z", text: "official clarification text" },
];

const call = (cacheKey: string) =>
  classifyStanceWithLlm({
    title: "terminal gate",
    updates: UPDATES,
    regexStance: { stance: "none", confidence: "low" },
    cacheKey,
    timeoutMs: 30_000,
  });

test("R10 反面:终局故障(未登录)仍是第一次就关闸 —— 收窄瞬断不许把这条一起放宽", () => {
  const saved = {
    bin: process.env.CLAUDE_BIN,
    cache: process.env.LLM_STANCE_CACHE,
    stance: process.env.LLM_STANCE,
    tries: process.env.LLM_STANCE_MAX_TRIES,
    backoff: process.env.LLM_STANCE_RETRY_BACKOFF_MS,
  };
  const dir = mkdtempSync(join(tmpdir(), "prededge-llmterm-"));
  const bin = join(dir, "fake-claude");
  // isTerminalLlmFailure 的 /not logged in/ 分支
  writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho "Error: not logged in" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.LLM_STANCE_CACHE = join(dir, "cache.json");
  delete process.env.LLM_STANCE;
  process.env.LLM_STANCE_MAX_TRIES = "3";
  process.env.LLM_STANCE_RETRY_BACKOFF_MS = "0";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  return (async () => {
    try {
      const c0 = llmCliCallCount();
      assert.equal(await call("qT:1"), null);
      // 终局:一次就返回,maxTries=3 也不重试
      assert.equal(llmCliCallCount(), c0 + 1, "终局故障不得重试");
      assert.match(warns.at(-1) ?? "", /terminal CLI failure/);
      assert.match(warns.at(-1) ?? "", /LLM gate off for this tick/);
      // 闸门已关:第二个事件直接短路,连 CLI 都不发
      assert.equal(await call("qU:1"), null);
      assert.equal(llmCliCallCount(), c0 + 1, "终局故障后闸门必须已关,不再发起调用");
      // 且不得走瞬断的计数文案(否则说明分流串线了)
      assert.ok(
        !warns.some((w) => /个不同事件耗尽/.test(w)),
        `终局故障不该出现瞬断计数文案: ${warns.join(" | ")}`
      );
    } finally {
      console.warn = origWarn;
      for (const [k, v] of Object.entries({
        CLAUDE_BIN: saved.bin,
        LLM_STANCE_CACHE: saved.cache,
        LLM_STANCE: saved.stance,
        LLM_STANCE_MAX_TRIES: saved.tries,
        LLM_STANCE_RETRY_BACKOFF_MS: saved.backoff,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
});
