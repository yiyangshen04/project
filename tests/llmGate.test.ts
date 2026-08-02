/**
 * R10 回归(2026-08-02 复查):判读闸门的爆炸半径。
 *
 * 缺陷形态:第一轮把"任意一次调用重试耗尽"直接写成 disabledThisProcess=true,
 * 于是**一个病态 prompt 就能掐掉整个 tick 的判读** —— 本 tick 剩余所有事件一律
 * 拿到 null,🟢 双确认档连同挂在它上面的自动下单闸门整体消失,而邮件表面一切
 * 正常(只有 llm:"unavailable" 一处看得出来)。prompt 体量跨度极大
 * (UPDATES_TOTAL_MAX_CHARS=12_000),官方文本堆满的大盘完全可能把单次超时连打
 * 三次 —— 那只证明"这个 prompt 太重",不足以证明线路已死。
 * 修法:瞬断要 **两个不同 cacheKey** 都重试耗尽才判线路级故障
 * (LLM_DISABLE_AFTER_FAILED_KEYS=2);终局故障(未登录/CLI 缺失/参数不被接受)
 * 维持第一次就关的既有语义。
 *
 * 单独成文件的原因:disabledThisProcess / exhaustedKeys 是模块级进程状态,
 * 而 node:test 每个测试文件跑在**独立子进程**里(已实测 pid 不同)。混进
 * tests/llmStance.test.ts 会与那里"预算不足"的用例共享计数,断言变成顺序耦合。
 *
 * 离线性:不触网。CLAUDE_BIN 指向本地临时目录里一个 4 行 sh 脚本,读完 stdin
 * 就往 stderr 打一句瞬断样的报错并 exit 1 —— 判读线路的失败注入必须走真实的
 * execFile 路径,否则测不到 isTerminalLlmFailure 的分流。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStanceWithLlm, llmCliCallCount } from "../lib/polymarket/llmStance";

/** 写一个必**瞬断**失败的假 CLI。stderr 文案刻意避开 isTerminalLlmFailure 的
 * 全部词(enoent / command not found / not logged in / unauthorized / 401 /
 * invalid api key / authentication / unknown option / invalid argument)——
 * 测的就是瞬断那条分支;终局分支见 tests/llmGateTerminal.test.ts。
 * `cat >/dev/null` 吃掉 stdin 上的 prompt,免得子进程早退触发 EPIPE 把失败
 * 形态改成别的。 */
function makeTransientFailingCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "prededge-llmgate-"));
  const bin = join(dir, "fake-claude");
  writeFileSync(
    bin,
    '#!/bin/sh\ncat >/dev/null\necho "proxy CONNECT tunnel failure: 502 Bad Gateway" >&2\nexit 1\n'
  );
  chmodSync(bin, 0o755);
  return bin;
}

const UPDATES = [
  { timestamp: 1, iso: "2026-08-02T00:00:00Z", text: "official clarification text" },
];

const call = (cacheKey: string) =>
  classifyStanceWithLlm({
    title: "gate blast radius",
    updates: UPDATES,
    regexStance: { stance: "none", confidence: "low" },
    cacheKey,
    timeoutMs: 30_000,
  });

test("R10:瞬断只关本事件 —— 单个 cacheKey 重试耗尽不许关掉整个 tick 的判读闸门", async () => {
  const saved = {
    bin: process.env.CLAUDE_BIN,
    cache: process.env.LLM_STANCE_CACHE,
    stance: process.env.LLM_STANCE,
    tries: process.env.LLM_STANCE_MAX_TRIES,
    backoff: process.env.LLM_STANCE_RETRY_BACKOFF_MS,
  };
  const dir = mkdtempSync(join(tmpdir(), "prededge-llmgate-cache-"));
  process.env.CLAUDE_BIN = makeTransientFailingCli();
  process.env.LLM_STANCE_CACHE = join(dir, "cache.json");
  delete process.env.LLM_STANCE;
  // maxTries=1 / backoff=0:重试次数与本条无关(R10 管的是"耗尽之后怎么办"),
  // 压到 1 只为让用例跑得快;耗尽语义与 maxTries=3 逐字相同。
  process.env.LLM_STANCE_MAX_TRIES = "1";
  process.env.LLM_STANCE_RETRY_BACKOFF_MS = "0";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    // 闸门是否还开着,唯一的外部可观测量就是"下一次调用还发不发 CLI"——
    // disabledThisProcess 命中时 classifyStanceWithLlm 在任何 execFile 之前 return。
    const c0 = llmCliCallCount();

    // ① 第一个事件重试耗尽:本事件降级为 null,闸门必须仍开。
    //    括号必须转义:llmStance 这条文案用的是**半角**括号(实测 0x28/0x29),
    //    不转义就成了捕获组、永远匹配不上 —— 与 refillPolicy 里 CLOB 拒单那条同源教训。
    assert.equal(await call("qA:1"), null);
    assert.equal(llmCliCallCount(), c0 + 1, "第一个事件应真的发起过 CLI 调用");
    assert.match(
      warns.at(-1) ?? "",
      /判读闸门仍开\(1\/2 个不同事件耗尽\)/,
      `第一次耗尽必须明说闸门仍开,实得: ${warns.at(-1)}`
    );

    // ② 同一个 cacheKey 再耗尽一次:去重集合里仍只有一个事件 —— 闸门照样开着。
    //    (缺陷版在 ① 就已经 disabledThisProcess=true,这里 CLI 调用数不会再涨。)
    assert.equal(await call("qA:1"), null);
    assert.equal(
      llmCliCallCount(),
      c0 + 2,
      "同一事件重复耗尽不得关闸 —— 闸门若被关掉,这次调用根本不会发出去"
    );
    assert.match(warns.at(-1) ?? "", /判读闸门仍开\(1\/2 个不同事件耗尽\)/);

    // ③ 第二个**不同**事件耗尽:这才是线路级证据,闸门关闭本 tick。
    assert.equal(await call("qB:1"), null);
    assert.equal(llmCliCallCount(), c0 + 3, "第二个事件仍应真的试过一次");
    assert.match(
      warns.at(-1) ?? "",
      /2 个不同事件重试耗尽 → 判读闸门关闭本 tick/,
      `第二个事件耗尽必须明说闸门关闭,实得: ${warns.at(-1)}`
    );

    // ④ 关闸之后:第三个事件直接短路,不再烧 CLI 预算。
    assert.equal(await call("qC:1"), null);
    assert.equal(llmCliCallCount(), c0 + 3, "闸门关闭后不得再发起任何 CLI 调用");
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
});
