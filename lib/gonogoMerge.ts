/**
 * go/no-go 材料的两来源合并与去重(2026-08-02 复查 R7 抽取)。
 *
 * 为什么单独成模块:这段判定决定"哪几笔真金进得了合计",而它此前是
 * scripts/gonogo-materials.ts 里 main() 内的一段内联循环,而那个文件顶层直接
 * `main()` —— import 它就会真的去打 Gamma/data-api 跑一份材料,因此无法被离线
 * 测试覆盖。R7 那个回归(日级去重键把同日两笔真实成交并成一条)正是在没有
 * 断言面的情况下落地的。抽出来后 tests/gonogoMerge.test.ts 能直接钉死
 * "同日同 token 的两笔真成交必须都留下、镜像拷贝必须被压掉"。
 *
 * 零依赖纯函数:无 fs/网络/env,输入输出都是普通对象。行为相对抽取前逐字未变。
 */

/** 两个来源(data/trade-ledger.jsonl 与 data/trade-attempts.jsonl)共用的行形状。
 * 字段都是可选的:两边写的键集合不同,且历史上换过格式。 */
export interface LedgerRow {
  at?: string;
  qid?: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: string;
  question?: string;
  label?: string;
  status?: string;
  reason?: string;
  mode?: string;
  probe?: boolean;
  signalAsk?: number | null;
  bestAsk?: number | null;
  bookEmpty?: boolean | null;
  filledUsd?: number;
  avgPrice?: number;
  feeUsd?: number;
  posted?: boolean | "unknown";
  token?: string;
  /** tradeExecutor 的一次执行标识(intent 行与终态行共享)。 */
  attemptId?: string;
}

/** 只装 ledger 行登记的 D 键 —— forensics 行拿自己的 D 键来这里对镜像。
 * 导出仅为可测:键的构造规则本身就是 R7 的缺陷面。 */
export function dayKeyOf(r: LedgerRow): string | null {
  const qid = r.qid ?? "";
  const token = r.tokenId ?? r.token ?? "";
  // 连 qid 与 token 都没有的残行(截断半行、更早期格式)没有身份可言,不参与
  // 镜像压制 —— 它们本来就定不了价,合并只会白吃决策计数。
  if (!qid && !token) return null;
  const day = String(r.at ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `D|${day}|${qid}|${token}|${r.conditionId ?? ""}|${r.status ?? ""}|${r.reason ?? ""}`;
}

/**
 * 合并两个来源:ledger 是 executeSignal 必写的,trade-attempts(chain-watch 的
 * forensics 留痕)覆盖前置 skip —— 那些分支在 executeSignal 之前 return,
 * ledger 里根本没有对应行。
 *
 * 去重是**不对称**的,不要退回成"一套键、任一命中就丢"(2026-08-02 复查:
 * 上一版正是那么写的,把补仓吃掉了,见第 3 段):
 *   A 键 = `A|<attemptId>`。全局唯一、两边同源、intent/终态/重试共享。带
 *          attemptId 的行**只**认 A 键。
 *   D 键 = `D|UTC日|qid|token|conditionId|status|reason`。只由 ledger 行**登记**、
 *          只由 forensics 行**查验**;唯一职责是压掉同一次执行在 chain-watch
 *          侧的那份镜像拷贝。
 *
 * 为什么不能用时间戳前缀当键(2026-08-02 审计 finding 11):ledger 行的 at 取自
 * tradeExecutor 内部 finish() 的时刻,forensics 行的 at 是 chain-watch 在
 * executeSignal **返回之后**新取的时刻 —— 同一笔的两个不同时点。一笔耗时 4 秒、
 * 起于 21:21:58 的成交会得到 …T21:21 与 …T21:22 两个 slice(0,16),去重直接失效、
 * 同一笔被列两遍(首版实测把 07-28 那笔记成 +$23.64 与 +$22.99)。分钟前缀只把
 * 故障率压到约 执行耗时/60s,并没有消除它,所以时间维度退到"同一 UTC 日"。
 *
 * 为什么带 attemptId 的行必须绕开 D 键查验(2026-08-02 复查,本轮修的就是这个
 * 回归):上一版对每行同时算 A 键与 D 键、判定写成 keys.some(k => seen.has(k)),
 * 于是同一天对同一 token 的第二笔真实成交(A 键明明唯一)被第一笔登记的 D 键
 * 否掉 —— 而"同日同 token 多笔成交"恰恰是本批新上线的补仓窗口的常态形态。
 * 复查实测:4 行合成(2 笔真成交 + 2 份镜像)只剩 1 条 verdict;本轮在 7 行
 * fixture(再加 1 条 intent + 2 条同日不同 reason 的 skip)上按同一机制复现为
 * 4 → 2,第二笔 $53 @0.69 的真实盈亏与一条 skip 一起蒸发。filled/partial 分支
 * 算的是**真金**(不是反事实),漏一笔就是系统性少计已赚的钱;讽刺的是旧的分钟
 * 键在 tick 间隔 ≥3min 时反而不会犯这个错 —— 这是新引入的反向偏差。
 *
 * 为什么 D 键里必须带 reason:两个来源的 reason 逐字同源(都取自 n.trade.reason /
 * attempt.reason),放进键里不削弱镜像压制;而没有它,同一天对同一 token 的多次
 * 不同原因 skip(注解缺基准 → 预告家族闸 → 额度闸)会被并成一条,bucketOf 的
 * 分桶计数跟着失真。
 *
 * 残留代价:执行跨 UTC 日(00:00 前后数秒完成)时镜像压不掉、多列一行。但
 * forensics 行没有 filledUsd 字段(它写的是 usd),进不了真实盈亏分支,所以最多
 * 多一条注明"缺字段无法核算"的决策记录,钱不会被记两遍。
 */
export function mergeLedgerAndForensics(ledger: LedgerRow[], attempts: LedgerRow[]): LedgerRow[] {
  const attemptSeen = new Set<string>();
  /** 只装 ledger 行登记的 D 键;forensics 行拿自己的 D 键来这里对镜像。 */
  const ledgerDayKeys = new Set<string>();
  const rows: LedgerRow[] = [];
  // ledger 在前:同一笔的两个版本里 ledger 行字段更全(outcome/filledUsd/avgPrice/
  // feeUsd 都只有它有),留下的必须是能定价的那条。
  for (const { r, fromLedger } of [
    ...ledger.map((r) => ({ r, fromLedger: true })),
    ...attempts.map((r) => ({ r, fromLedger: false })),
  ]) {
    const id = r.attemptId;
    if (id) {
      if (attemptSeen.has(`A|${id}`)) continue;
      attemptSeen.add(`A|${id}`);
    }
    const dk = dayKeyOf(r);
    if (fromLedger) {
      // 登记而不查验:ledger 内部不存在自镜像 —— intent/终态早已按 attemptId 折叠,
      // 其余每次执行只写一行,所以同日同 token 的两条 ledger 行必然是两次真实决策,
      // 谁也不该压掉谁(补仓正是这个形态)。
      if (dk) ledgerDayKeys.add(dk);
    } else if (!id && dk && ledgerDayKeys.has(dk)) {
      // 这是 ledger 那一行在 chain-watch 侧的镜像拷贝,压掉。forensics 彼此之间
      // 不去重:appendTradeForensics 每次决策只写一行,同源重复不存在,互相去重
      // 只会把同日的多次 skip 并没了。
      continue;
    }
    rows.push(r);
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return rows;
}
