/**
 * R7 回归(2026-08-02 复查):go/no-go 材料合并两个留痕来源时,日级去重键
 * 把**同日对同一 token 的两笔真实成交**并成了一条。
 *
 * 缺陷形态:上一版对每行同时算 A 键(`A|attemptId`,全局唯一)与 D 键
 * (`D|UTC日|qid|token|cid|status|reason`,用来压 chain-watch 侧的镜像拷贝),
 * 判定写成 `keys.some(k => seen.has(k))` —— 于是第二笔真成交(A 键明明唯一)
 * 被第一笔登记的 D 键否掉。而"同日同 token 多笔成交"恰恰是本批新上线的补仓
 * 窗口的常态形态,filled 分支算的是**真金**,漏一笔就是系统性少计已赚的钱。
 *
 * 修法是让去重**不对称**:带 attemptId 的行只认 A 键;D 键只由 ledger 行登记、
 * 只由 forensics 行查验。本文件按这个语义逐条钉死。
 * 全部离线:纯函数 + 内联 fixture,无 fs/网络。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLedgerAndForensics, dayKeyOf, type LedgerRow } from "../lib/gonogoMerge";

/** 07-28 原型的两笔:21:21:58 首单 $47 @0.664,21:26 补仓 $53 @0.69。
 * 首单刻意起于 :58 —— 执行耗时约 4s,ledger 行与 forensics 镜像因此落在 21:21
 * 与 21:22 两个不同分钟,复现旧分钟前缀键失效的那个形态。
 * 同一 UTC 日、同一 qid/token/conditionId、同一 status,filled 行没有 reason
 * —— 即两行的 D 键**逐字相同**,这正是 R7 触发的条件。 */
const ledgerFill1: LedgerRow = {
  at: "2026-07-28T21:21:58.718Z",
  attemptId: "att-1",
  qid: "0xaaa",
  tokenId: "tok-1",
  conditionId: "cid-1",
  outcome: "Yes",
  question: "Hurricane family leg A",
  status: "filled",
  mode: "live",
  filledUsd: 47,
  avgPrice: 0.664,
};
const ledgerFill2: LedgerRow = {
  at: "2026-07-28T21:26:11.204Z",
  attemptId: "att-2",
  qid: "0xaaa",
  tokenId: "tok-1",
  conditionId: "cid-1",
  outcome: "Yes",
  question: "Hurricane family leg A",
  status: "filled",
  mode: "live",
  filledUsd: 53,
  avgPrice: 0.69,
};
/** chain-watch 侧对上面两笔的 forensics 镜像。at 是 executeSignal **返回之后**
 * 新取的时刻(比 ledger 行晚几秒,可跨分钟),金额字段名是 usd 不是 filledUsd。
 * 无 attemptId —— 这正是它们该被 D 键压掉的那一类。 */
const mirror1: LedgerRow = {
  at: "2026-07-28T21:22:02.902Z",
  qid: "0xaaa",
  tokenId: "tok-1",
  conditionId: "cid-1",
  status: "filled",
  mode: "live",
};
const mirror2: LedgerRow = {
  at: "2026-07-28T21:26:15.331Z",
  qid: "0xaaa",
  tokenId: "tok-1",
  conditionId: "cid-1",
  status: "filled",
  mode: "live",
};

test("R7:同日对同一 token 的两笔真实成交都必须留下(补仓窗口的常态形态)", () => {
  const rows = mergeLedgerAndForensics([ledgerFill1, ledgerFill2], [mirror1, mirror2]);
  // 缺陷版(A/D 两键任一命中即丢)在这里只剩 1 条:第二笔 $53 @0.69 蒸发。
  assert.equal(rows.length, 2, `期望两笔真成交都在,实得 ${rows.length} 条`);
  const usd = rows.map((r) => r.filledUsd).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(usd, [47, 53], "两笔的 filledUsd 都必须原样在场(真金,不是反事实)");
  // 留下的必须是 ledger 那份(字段全、能定价),不是 forensics 镜像
  assert.ok(
    rows.every((r) => r.attemptId != null && r.avgPrice != null),
    "留下的应是字段更全的 ledger 行"
  );
  // 按时间升序
  assert.deepEqual(rows.map((r) => r.attemptId), ["att-1", "att-2"]);
});

test("R7:forensics 镜像仍被压掉 —— 修 R7 不许把镜像压制一起放跑", () => {
  // 只给一笔 + 它的镜像:必须剩 1 条,且是 ledger 那条。
  const rows = mergeLedgerAndForensics([ledgerFill1], [mirror1]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attemptId, "att-1");
  assert.equal(rows[0].filledUsd, 47);
  // 镜像的 at 与 ledger 行差 4 秒且跨了分钟边界 —— 旧的 slice(0,16) 分钟前缀键
  // 在这里就失效了(这也是 D 键退到"同一 UTC 日"的原因)。
  assert.notEqual(ledgerFill1.at!.slice(0, 16), mirror1.at!.slice(0, 16));
  assert.equal(dayKeyOf(ledgerFill1), dayKeyOf(mirror1));
});

test("R7:intent 行按 A 键折叠,同日不同 reason 的多次 skip 各自保留", () => {
  // intent 行(write-ahead)与终态行共享 attemptId —— A 键去重只留先来的那条。
  const intent: LedgerRow = { ...ledgerFill1, at: "2026-07-28T21:21:50.001Z", status: "intent" };
  // 同日同 token 的两次不同原因 skip(forensics 前置 skip,ledger 里没有对应行):
  // D 键里带 reason,所以两条都留得下,bucketOf 的分桶计数才不失真。
  const skipA: LedgerRow = {
    at: "2026-07-28T20:10:00.000Z",
    qid: "0xaaa",
    tokenId: "tok-1",
    conditionId: "cid-1",
    status: "skipped",
    reason: "信号注解无盘口基准(bestAskAtSignal=null),人工确认后手动下单",
  };
  const skipB: LedgerRow = {
    at: "2026-07-28T20:40:00.000Z",
    qid: "0xaaa",
    tokenId: "tok-1",
    conditionId: "cid-1",
    status: "skipped",
    reason: "日额度已满($800/800)",
  };
  const rows = mergeLedgerAndForensics([ledgerFill1, ledgerFill2], [mirror1, mirror2, skipA, skipB, intent]);
  // 2 笔真成交 + 2 条不同原因的 skip = 4;两份镜像被压掉;intent 与 att-1 同键被折叠。
  assert.equal(rows.length, 4, `实得 ${rows.length} 条: ${rows.map((r) => `${r.status}@${r.at}`).join(", ")}`);
  assert.equal(rows.filter((r) => r.status === "filled").length, 2);
  assert.equal(rows.filter((r) => r.status === "skipped").length, 2);
  assert.equal(rows.filter((r) => r.status === "intent").length, 0);
});

test("R7:dayKeyOf —— 无身份的残行不参与镜像压制,at 不可解析同样退出", () => {
  // 连 qid 与 token 都没有的截断半行:没有身份可言,返回 null(不压制、也不被压制)
  assert.equal(dayKeyOf({ at: "2026-07-28T21:21:58.718Z", status: "filled" }), null);
  // at 缺失/格式非 YYYY-MM-DD → null
  assert.equal(dayKeyOf({ qid: "0xaaa", status: "filled" }), null);
  assert.equal(dayKeyOf({ at: "not-a-date", qid: "0xaaa", status: "filled" }), null);
  // 两条无身份残行必须都留下(不该被合并掉,它们本来就定不了价)
  const junk1: LedgerRow = { at: "2026-07-28T01:00:00.000Z", status: "skipped", reason: "x" };
  const junk2: LedgerRow = { at: "2026-07-28T02:00:00.000Z", status: "skipped", reason: "x" };
  assert.equal(mergeLedgerAndForensics([], [junk1, junk2]).length, 2);
  // token 兼容旧键名 `token`(forensics 侧写的是 token,不是 tokenId)
  assert.equal(
    dayKeyOf({ at: "2026-07-28T21:21:58.718Z", qid: "0xaaa", token: "tok-1", conditionId: "cid-1", status: "filled" }),
    dayKeyOf(ledgerFill1)
  );
});

test("R7:跨 UTC 日的镜像压不掉(已知残留代价),但钱不会被记两遍", () => {
  // 00:00 前后数秒完成的执行:两行落在不同 UTC 日,D 键不同 → 镜像多列一行。
  const lateFill: LedgerRow = { ...ledgerFill1, at: "2026-07-28T23:59:58.100Z" };
  const nextDayMirror: LedgerRow = { ...mirror1, at: "2026-07-29T00:00:02.400Z" };
  const rows = mergeLedgerAndForensics([lateFill], [nextDayMirror]);
  assert.equal(rows.length, 2, "已知残留:跨日镜像压不掉");
  // 但镜像行没有 filledUsd,进不了真实盈亏分支 —— 钱只被记一次。
  assert.equal(rows.filter((r) => r.filledUsd != null).length, 1);
});
