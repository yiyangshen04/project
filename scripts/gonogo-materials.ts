/**
 * go/no-go 替代口径材料生成器(2026-08-02 复盘产物)。
 *
 * 为什么需要它:8 月中要决定预告家族要不要开实弹(EXEC_FORECAST_LIVE),
 * 而 paper 池长期 0 行(登记门槛卡在 fill100,本批已修但样本要从现在才开始
 * 攒)、实盘只有 n=1。统计判定这条路今年走不通,只能改用替代口径。
 *
 * 本脚本产出两层(第三层"生产闸门代码对历史行情重放"做不了,原因见下):
 *
 *   层 1 · 闸门行为审计 —— 把 data/trade-ledger.jsonl 与 data/trade-attempts.jsonl
 *         里每一次执行决策列出来,按 skip 原因分桶。回答"该拦的都拦对了吗"。
 *
 *   层 3 · 反事实结算 —— 对每个被 skip 的绿档,查 Gamma(带 closed=true)拿最终
 *         结算结果,再用 data-api 真实成交查信号时点之后market上真实成交过的价
 *         (禁用 prices-history:占位价幻象已实锤),算出"如果当时做了会怎样"。
 *         bookEmpty 桶单列且不计入 PnL —— 空盘时 taker 任何价位都不可成交,
 *         把它算成"错过的钱"是自欺欺人。成交查询按 offset 翻页翻到信号时点被
 *         真正覆盖为止;翻到上限/取数失败仍覆盖不到的,记"不可定价"(计入
 *         unpriceable、不进 PnL),绝不写成 $0 机会成本 —— "翻不到"与"没人成交"
 *         混同会让整份材料系统性偏乐观(2026-08-02 审计 finding 10)。
 *
 *   层 2(未实现,刻意):把生产闸门代码对 07-01→08-15 的历史信号重放一遍。
 *         做不了的原因是没有历史信号可重放 —— scan_runs/opportunities 三表
 *         至今 0 行(persistScanResult 从未被 cron 调用,本批已修),chain-watch
 *         日志每周日被截断,notified 指纹表不含方向/价格/时间。等落库跑满 3 周
 *         后这一层才有输入。不要用"现在能拿到的残缺数据"硬凑一个层 2,那会
 *         给出一个看起来有统计量、实际不可信的结论。
 *
 * 用法。注意:在 sufe 上必须经 run-cron.sh —— 它会 source .env 带上代理,
 * 直接 npx tsx 跑的话 Gamma/data-api 在国内直连不可达,全部条目会显示
 * "不可定价"(实测踩过一次,结果看起来像"没数据",其实是没代理)。
 *   ./run-cron.sh scripts/gonogo-materials.ts           # 生产机(带代理)
 *   npx tsx scripts/gonogo-materials.ts                 # 本机(能直连时)
 *   ./run-cron.sh scripts/gonogo-materials.ts --json    # 机读
 *   ./run-cron.sh scripts/gonogo-materials.ts --usd 50  # 反事实按每笔 $50 计
 *   npx tsx scripts/gonogo-materials.ts --dir <拉下来的 data 目录>
 *
 * 只读:不下单、不改任何状态文件。
 */
import fs from "node:fs";
import path from "node:path";
// LedgerRow 与两来源合并去重已移入 lib/gonogoMerge.ts(零依赖纯函数,可离线断言)。
// 行形状必须两边共用一份,否则字段漂移无人发现。
import { mergeLedgerAndForensics, type LedgerRow } from "../lib/gonogoMerge";

const ROOT = path.resolve(__dirname, "..");
const GAMMA = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
/** 反事实口径的每笔名义金额。必须先 includes 再取值(与下面 --dir 同写法):
 * indexOf 未命中返回 -1,`argv[-1 + 1]` 就是 argv[0] —— 此前只是碰巧 argv[0]
 * 多为 "--json" 之类才回落到 50,而 `gonogo-materials.ts 100` 会静默把 100 当成
 * notional,整份材料的金额口径被一个位置参数改掉却毫无提示(2026-08-02 审计)。 */
const NOTIONAL = argv.includes("--usd") ? Number(argv[argv.indexOf("--usd") + 1]) || 50 : 50;
/** 数据目录覆盖。生产账本在 sufe(`ssh sufe "cat ~/prededge/data/xxx" > 本地`),
 * 拉下来之后用 --dir 指向那个目录跑,不必污染本地 data/。 */
const DATA_DIR = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : null;

function readJsonl(file: string): LedgerRow[] {
  const p = DATA_DIR ? path.join(DATA_DIR, path.basename(file)) : path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  const out: LedgerRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerRow);
    } catch {
      // 半行容忍(append-only,崩溃截断不影响其余)
    }
  }
  return out;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface GammaMarketLite {
  question: string;
  conditionId: string;
  closed?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  umaResolutionStatus?: string;
  volume?: string;
}

/** conditionId → Gamma 市场(null = 查得到但没有这个市场)的进程内缓存。
 * 同一个 cid 会被多行反复问:一条澄清触发家族多腿、补仓复访每次留痕一行,
 * 逐行重拉纯属浪费墙钟与速率额度(2026-08-02 审计 finding 10c)。
 * 只缓存"取数成功"的结果 —— 取数失败(代理瞬断/超时)不写缓存,否则一次
 * 瞬断会把整轮该 cid 的条目全钉死成"查不到",而那正是自我美化方向。 */
const gammaMarketCache = new Map<string, GammaMarketLite | null>();

/** 结算结果:返回该 outcome 名对应的结算价(1 = 赢,0 = 输,null = 未结算/查不到)。
 * 存量查询必须带 closed=true —— 不带的话已关闭市场直接查不到(既有血泪)。 */
async function settledPriceFor(conditionId: string, outcome: string): Promise<number | null> {
  let m = gammaMarketCache.get(conditionId);
  if (m === undefined) {
    // 缓存里存的永远是 GammaMarketLite 或 null,所以 undefined 只可能是"没查过"。
    const arr = await getJson<GammaMarketLite[]>(
      `${GAMMA}/markets?condition_ids=${conditionId}&closed=true`
    );
    if (!arr) return null;
    m = arr[0] ?? null;
    gammaMarketCache.set(conditionId, m);
  }
  if (!m || m.closed !== true) return null;
  try {
    const names = JSON.parse(m.outcomes ?? "[]") as string[];
    const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
    const i = names.findIndex((n) => n.trim().toLowerCase() === outcome.trim().toLowerCase());
    if (i < 0) return null;
    const p = Number(prices[i]);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

interface TradeLite {
  timestamp: number;
  side: string;
  outcome: string;
  price: number;
  size: number;
  /** 翻页去重用(见 tradeTapeUntil);老响应可能没有,没有就不去重。 */
  transactionHash?: string;
}

/** data-api `/trades` 单页上限。 */
const TRADES_PAGE = 1_000;
/** `/trades` 的 offset 上限 —— 服务端硬上限,不是我们的保守值。
 * 2026-08-02 复查实测(只读打真实请求,cid=0x0b4cc3b7…4bee "Jesus Christ return"):
 *   offset=3000/4000/9000/9500/10000 → 各返回满页;
 *   offset=10500/11000/12000 → HTTP 400 {"error":"max historical trades offset
 *   of 10000 exceeded"}。
 * 所以 10000 是官方自己说出口的边界(与记忆 `polymarket-cohort-c-collection`
 * 里量到的分页上限一致);此前写 4000 是 bt4 2026-07-09 在 MSTR 巨盘上的经验
 * 值,它把覆盖能力砍掉一半 —— 活跃盘 4000 笔只跨约 5.4 小时(MSTR 实测 4000 笔
 * = 19,527 秒),07-01→08-15 的审计行绝大多数会落进"不可定价",材料几乎打不出数。
 * 超限时服务端是 400 而不是"空页",getJson 因 !res.ok 返回 null → tape.failed →
 * covered=false → 记"不可定价",所以放宽到真实上限不会把"翻不到"洗成 $0;
 * 「翻到上限仍未覆盖 afterMs 就报不可定价、绝不报 $0」的既有逻辑原样保留。 */
const TRADES_MAX_OFFSET = 10_000;

/** 一个 conditionId 已翻到的成交带(时间倒序,越翻越老)。 */
interface TradeTape {
  trades: TradeLite[];
  /** 已翻到的最老一笔时间戳(秒);null = 一条都还没拿到。 */
  oldestTs: number | null;
  /** 某页不足整页 = 已到历史尽头,再翻也没有更老的了。 */
  exhausted: boolean;
  /** 撞到 offset 上限:更老的成交服务端不给,窗口有没有被覆盖不可知。 */
  capped: boolean;
  /** 本次调用取数失败(代理/超时/5xx)。不粘住:下次调用会从断点续翻。 */
  failed: boolean;
  nextOffset: number;
  /** 已收录成交的指纹,翻页期间新成交插到 offset=0 会让窗口整体后移、
   * 同一笔被翻到两次;重复计入会虚增 usd 与 vwap 分母。 */
  seen: Set<string>;
}
/** conditionId → 成交带。进程内缓存,同一 cid 的多行(家族多腿、补仓多次留痕)
 * 复用已翻到的页,只在需要更老的成交时继续往后翻(2026-08-02 审计 finding 10c)。
 *
 * 2026-08-02 三轮复查(N5):R8 把 TRADES_MAX_OFFSET 从 4000 提到 10000 后,单个
 * cid 的常驻足迹放大 2.5 倍,而这个 Map 原本无任何淘汰 —— 07-01→08-15 全量跑会
 * 把碰到的每个 cid 永久钉在堆上。足迹估算(V8,单字节字符串):
 *   一行 TradeLite ≈ 对象头+槽 64B + txHash(66 字符)≈ 88B + side/outcome ≈ 48B
 *                    + 数字 ≈ 50B + 数组槽 8B ≈ 260B  → 10k 行 ≈ 2.6 MB
 *   seen 指纹串 ≈ 90 字符 ≈ 106B + Set 槽 ≈ 24B ≈ 130B → 10k 条 ≈ 1.3 MB
 *   每 cid 最坏 ≈ 4 MB;N≈50 个 cid 无淘汰 ≈ 200 MB 常驻,跑不动时表现为 OOM。
 * OOM = 整份材料 fatal 退出,比"这一条不可定价"更糟,与本脚本的诚实取向相反。
 * 因此加 LRU 上限:最坏 16×4 MB ≈ 64 MB(翻页终局后 seen 会被丢,实际更低)。
 * 选 16 而非更小:留痕行按时间顺序处理,同一 cid 的多腿/复访都聚在几小时内,
 * 时间局部性强,16 路足以吃到绝大多数复用;被淘汰的 cid 下次只是从 offset=0
 * 重翻(多花请求),covered / 不可定价 的判据一字不变 —— 淘汰绝不改变定价语义。 */
const TAPE_CACHE_MAX = 16;
const tradeTapeCache = new Map<string, TradeTape>();

/** 按 offset 翻页拉 conditionId 的真实成交,直到:翻到的最老一笔早于 untilTs
 * (窗口已被覆盖)、翻到历史尽头、撞上 offset 上限、或取数失败为止。 */
async function tradeTapeUntil(conditionId: string, untilTs: number): Promise<TradeTape> {
  let tape = tradeTapeCache.get(conditionId);
  if (tape) {
    // LRU 触碰:删掉再插回队尾,淘汰时才淘汰得到"最久没被访问的 cid"(N5)。
    tradeTapeCache.delete(conditionId);
    tradeTapeCache.set(conditionId, tape);
  } else {
    tape = {
      trades: [],
      oldestTs: null,
      exhausted: false,
      capped: false,
      failed: false,
      nextOffset: 0,
      seen: new Set<string>(),
    };
    tradeTapeCache.set(conditionId, tape);
    // 只在新增之后收口:刚插入的一定在队尾,循环不会淘汰到自己。被淘汰的 tape
    // 若正被上层持有,对象本身照常有效(只是不再被复用),故淘汰无副作用(N5)。
    while (tradeTapeCache.size > TAPE_CACHE_MAX) {
      const oldest: string | undefined = tradeTapeCache.keys().next().value;
      if (oldest === undefined) break;
      tradeTapeCache.delete(oldest);
    }
  }
  tape.failed = false;
  while (!tape.exhausted && !tape.capped && (tape.oldestTs == null || tape.oldestTs > untilTs)) {
    if (tape.nextOffset >= TRADES_MAX_OFFSET) {
      tape.capped = true;
      break;
    }
    const page = await getJson<TradeLite[]>(
      `${DATA_API}/trades?market=${conditionId}&limit=${TRADES_PAGE}&offset=${tape.nextOffset}`
    );
    // 非数组也当取数失败(2026-08-02 复查):超限时服务端返回的是
    // {"error":"max historical trades offset of 10000 exceeded"}。它现在带
    // HTTP 400、被 getJson 吃成 null,但若哪天改成 200 带错误体,下面的
    // for…of 会对着一个对象抛 TypeError 让整份材料 fatal 退出。判到非数组就
    // 走 failed(→ 不可定价),方向与 finding 10 一致:宁可说不知道。
    if (!page || !Array.isArray(page)) {
      tape.failed = true;
      break;
    }
    for (const t of page) {
      const fp = t.transactionHash
        ? `${t.transactionHash}|${t.outcome}|${t.side}|${t.price}|${t.size}`
        : null;
      if (fp) {
        if (tape.seen.has(fp)) continue;
        tape.seen.add(fp);
      }
      tape.trades.push(t);
      if (Number.isFinite(t.timestamp) && (tape.oldestTs == null || t.timestamp < tape.oldestTs)) {
        tape.oldestTs = t.timestamp;
      }
    }
    tape.nextOffset += page.length;
    if (page.length < TRADES_PAGE) tape.exhausted = true;
  }
  // 翻页一旦终局(到历史尽头 exhausted / 撞 offset 上限 capped),while 条件里这两
  // 个标志任一为真都不再发起请求,seen 从此再无读者 —— 丢掉它,每 cid 省下最多
  // ≈1.3 MB(N5 足迹估算见 TAPE_CACHE_MAX 处)。trades 不动:定价还要用。
  // 注意 failed 不算终局(每次调用开头会重置、可断点续翻),那种情况必须留着 seen,
  // 否则续翻会把已收录的成交重复计入,虚增 usd 与 vwap 分母(2026-08-02 三轮复查)。
  if (tape.exhausted || tape.capped) tape.seen.clear();
  return tape;
}

/** 信号后窗口的成交探针。covered=false 是显式的"不可定价"状态 —— 绝不退化成
 * n=0,那会被上层写成"想做也做不成,机会成本 ≈ $0"(2026-08-02 审计 finding 10)。 */
type FillsProbe =
  | { covered: true; n: number; vwap: number | null; usd: number }
  | { covered: false; why: string };

/** 信号时点之后该市场真实成交过的最优可得买价与可吃量。
 * 只认 data-api 真实成交 —— prices-history 的占位价幻象已被 bt3 实锤
 * (旧 +136% 结论半数是幻象)。
 * data-api 按时间倒序返回,单取最近 1000 笔时:信号越久远、市场越活跃,信号后
 * 30 分钟窗口越可能整体掉在这 1000 笔之外,于是"其实做得成"被写成 $0 机会成本
 * (2026-08-02 审计 finding 10)。所以这里翻页翻到窗口被真正覆盖为止,覆盖不了
 * 就明说覆盖不了。 */
async function realFillsAfter(
  conditionId: string,
  outcome: string,
  afterMs: number,
  windowMs = 30 * 60_000
): Promise<FillsProbe> {
  const lo = afterMs / 1000;
  const hi = (afterMs + windowMs) / 1000;
  const tape = await tradeTapeUntil(conditionId, lo);
  // 覆盖判据:要么翻到了一笔早于信号时点的成交(窗口整体在已取到的范围内),
  // 要么翻到了历史尽头(比这更老的成交根本不存在)。二者皆非 = 不可定价。
  const covered = tape.exhausted || (tape.oldestTs != null && tape.oldestTs <= lo);
  if (!covered) {
    return {
      covered: false,
      why: tape.failed ? "data-api 取数失败(代理/超时)" : "data-api 分页上限内未覆盖信号时点",
    };
  }
  const hits = tape.trades.filter(
    (t) =>
      t.timestamp >= lo &&
      t.timestamp <= hi &&
      String(t.outcome).trim().toLowerCase() === outcome.trim().toLowerCase()
  );
  if (hits.length === 0) return { covered: true, n: 0, vwap: null, usd: 0 };
  const usd = hits.reduce((s, t) => s + t.price * t.size, 0);
  const shares = hits.reduce((s, t) => s + t.size, 0);
  return { covered: true, n: hits.length, vwap: shares > 0 ? usd / shares : null, usd };
}

interface Verdict {
  at: string;
  question: string;
  conditionId: string;
  outcome: string;
  label: string;
  status: string;
  reason: string;
  bucket: string;
  settled: number | null;
  postSignalFills: number | null;
  postSignalVwap: number | null;
  postSignalUsd: number | null;
  /** 非 null = 信号后窗口取不到可信成交(分页上限/取数失败/at 不可解析),
   * 该条目按"不可定价"处理:进 byBucket 的 unpriceable、不进 PnL。
   * 与 postSignalFills=0("确实没人成交")是两回事,混同即自我美化。 */
  postSignalUncovered: string | null;
  /** 反事实盈亏:仅当"确有对手方成交"且"已结算"时才给数;否则 null 并说明。 */
  counterfactualPnl: number | null;
  note: string;
}

/** skip 原因归桶 —— 桶名直接对应"这次拦对了没有"的判据。 */
function bucketOf(reason: string, bookEmpty: boolean | null | undefined): string {
  const r = reason || "";
  if (bookEmpty === true || /空盘/.test(r)) return "空盘(物理不可成交)";
  if (/市场已关闭/.test(r)) return "市场已关闭(结算后补发澄清)";
  if (/无盘口基准/.test(r)) return "注解缺基准";
  if (/预告模板家族|预告家族/.test(r)) return "预告家族闸";
  if (/累计敞口已满|日额度|总敞口|同事件聚合/.test(r)) return "额度闸";
  if (/漂移带|暴跌/.test(r)) return "价格漂移闸";
  if (/上限|下限/.test(r)) return "价格带闸";
  if (/深度不足/.test(r)) return "深度不足";
  if (/kill-switch|连亏/.test(r)) return "熔断";
  if (/方向映射/.test(r)) return "方向映射非白名单";
  if (/EXEC_MODE=off/.test(r)) return "执行关闭";
  return "其他";
}

async function main(): Promise<void> {
  // write-ahead intent 行会被同 attemptId 的终态行取代(与 tradeExecutor 的
  // collapseAttempts 同语义)。不折叠的话一笔成交会被算两次 —— 首版实测把
  // 07-28 那笔记成了 +$23.64 与 +$22.99 两笔。孤儿 intent(进程死在 postOrder
  // 在途窗口)保留:那才是真的"结果未知"。
  const rawLedger = readJsonl("data/trade-ledger.jsonl").filter((r) => !r.probe);
  const lastOfAttempt = new Map<string, number>();
  rawLedger.forEach((r, i) => {
    const id = (r as { attemptId?: string }).attemptId;
    if (id) lastOfAttempt.set(id, i);
  });
  const ledger = rawLedger.filter((r, i) => {
    const id = (r as { attemptId?: string }).attemptId;
    return !id || lastOfAttempt.get(id) === i;
  });
  const attempts = readJsonl("data/trade-attempts.jsonl");

  // 两来源合并 + 不对称去重(A 键/D 键的完整依据见 lib/gonogoMerge.ts):
  // 判定本身决定「哪几笔真金进得了合计」,却因本文件顶层直接 main()(import 即
  // 真跑一份材料)长期没有断言面 —— R7 的日级键回归正是这么落地的。抽成纯函数
  // 后逐条钉死在 tests/gonogoMerge.test.ts,取值与行为逐字未变。
  const rows = mergeLedgerAndForensics(ledger, attempts);

  const verdicts: Verdict[] = [];
  for (const r of rows) {
    const cid = r.conditionId;
    const outcome = r.outcome;
    const bucket = bucketOf(r.reason ?? "", r.bookEmpty);
    const base: Verdict = {
      at: r.at ?? "",
      question: r.question ?? "(unknown)",
      conditionId: cid ?? "",
      outcome: outcome ?? "",
      label: r.label ?? "",
      status: r.status ?? "",
      reason: r.reason ?? "",
      bucket,
      settled: null,
      postSignalFills: null,
      postSignalVwap: null,
      postSignalUsd: null,
      postSignalUncovered: null,
      counterfactualPnl: null,
      note: "",
    };
    if (!cid || !outcome) {
      base.note = "缺 conditionId/outcome,无法反事实核算(旧留痕行字段不全)";
      verdicts.push(base);
      continue;
    }
    base.settled = await settledPriceFor(cid, outcome);
    const afterMs = Date.parse(r.at ?? "");
    if (Number.isFinite(afterMs)) {
      const fills = await realFillsAfter(cid, outcome, afterMs);
      if (fills.covered) {
        base.postSignalFills = fills.n;
        base.postSignalVwap = fills.vwap;
        base.postSignalUsd = Math.round(fills.usd * 100) / 100;
      } else {
        base.postSignalUncovered = fills.why;
      }
    } else {
      // 没有可解析的信号时点就无从划窗口;沉默地留 postSignalFills=null 会掉进
      // 下面的"零真实成交 ≈ $0"分支,同样是把不知道说成没机会。
      base.postSignalUncovered = "留痕行 at 不可解析,取不到信号时点";
    }
    if (r.status === "filled" || r.status === "partial") {
      // 已成交:真实盈亏,不是反事实。
      if (base.settled != null && r.filledUsd != null && r.avgPrice) {
        const shares = r.filledUsd / r.avgPrice;
        base.counterfactualPnl =
          Math.round((shares * base.settled - r.filledUsd - (r.feeUsd ?? 0)) * 100) / 100;
        base.note = "已成交(真实盈亏,非反事实)";
      } else if (base.settled == null) {
        // 2026-08-02 复查:原来这里没有 else,这类行输出 note:"" —— 读者只看到
        // 一条"不计价"却不知道为什么,很容易顺手读成"这笔没赚到"。已成交但未结算
        // 是最常见的形态(持仓还在市场上),必须自己说出口。
        base.note = "已成交但市场尚未结算,盈亏待定(不计入合计,结算后重跑本脚本)";
      } else {
        // 已结算却算不出:留痕行缺 filledUsd/avgPrice。典型来源是跨 UTC 日没被
        // 压掉的 forensics 镜像行(它写的字段名是 usd 不是 filledUsd),也可能是
        // 更早期格式的 ledger 行。宁可标注不可核算,也不拿 usd 硬凑成真实盈亏。
        base.note = "已成交但留痕行缺 filledUsd/avgPrice,无法核算真实盈亏(疑为 forensics 镜像行或早期格式)";
      }
    } else if (bucket === "空盘(物理不可成交)") {
      base.note = "空盘:taker 任何价位不可成交,不计入错过的钱(计入即自欺)";
    } else if (base.settled == null) {
      base.note = "尚未结算,无法核算";
    } else if (base.postSignalUncovered) {
      base.note = `${base.postSignalUncovered},窗口不可定价`;
    } else if (!base.postSignalFills) {
      base.note = "信号后窗口内零真实成交 —— 想做也做不成,机会成本 ≈ $0";
    } else if (base.postSignalVwap != null) {
      const shares = Math.min(NOTIONAL, base.postSignalUsd ?? 0) / base.postSignalVwap;
      base.counterfactualPnl =
        Math.round((shares * base.settled - shares * base.postSignalVwap) * 100) / 100;
      base.note = `反事实:按信号后 30min 内真实成交 VWAP ${base.postSignalVwap.toFixed(3)} 吃 $${Math.min(NOTIONAL, base.postSignalUsd ?? 0).toFixed(0)}(受该窗口真实成交额约束)`;
    } else {
      // 2026-08-02 三轮复查(N4):走到这里的唯一形态是 postSignalFills > 0 却
      // postSignalVwap == null —— realFillsAfter 只在 shares > 0 时给 vwap,所以
      // 命中的成交 size 全为 0(异常/零份额流水)就会落空。原来三个 else if 全不
      // 命中,note 停在 ""、counterfactualPnl 停在 null,逐笔行只印出"不计价 · ",
      // 读者无法把它与"确实没机会"区分开。R9 已经修过 filled/partial 那一侧的同
      // 病,反事实这一侧一并说出口。仍然不计价:没有份额就没有可成交的价。
      base.note = `信号后窗口命中 ${base.postSignalFills} 笔成交但份额均为 0(成交额 $${base.postSignalUsd ?? 0}),定不出 VWAP,不可定价`;
    }
    // 兜底:上面任一路径若漏写 note,逐笔行会退化成"不计价 · "(空说明),而"空
    // note"与"明确说明为什么不可定价"在阅读上是天壤之别 —— 这个脚本的全部价值
    // 就是诚实核算。现有分支已逐条覆盖(N4 已补最后一个口),这行只为将来新增
    // 分支时不再复发,不改变任何金额与桶计数(2026-08-02 三轮复查)。
    if (!base.note) {
      base.note = "未归类:本行未落入任何核算分支,按不可定价处理(请检查脚本分支覆盖)";
    }
    verdicts.push(base);
  }

  const byBucket = new Map<string, { n: number; pnl: number; unpriceable: number }>();
  for (const v of verdicts) {
    // counterfactualPnl == null 即"不可定价",窗口取不到成交(postSignalUncovered)
    // 的条目正是靠这条落进 unpriceable 而不进 pnl —— 别把它改成按 fills 判(那会
    // 让"翻不到"重新混进"零成交",2026-08-02 审计 finding 10)。
    const b = byBucket.get(v.bucket) ?? { n: 0, pnl: 0, unpriceable: 0 };
    b.n += 1;
    if (v.counterfactualPnl == null) b.unpriceable += 1;
    else b.pnl += v.counterfactualPnl;
    byBucket.set(v.bucket, b);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ notional: NOTIONAL, verdicts, byBucket: [...byBucket] }, null, 1));
    return;
  }

  console.log(`\n=== go/no-go 材料 · 层1 闸门行为审计 + 层3 反事实结算 ===`);
  console.log(`口径:每笔 $${NOTIONAL};价源 = data-api 真实成交(禁 prices-history);`);
  console.log(`      结算 = Gamma closed=true;空盘桶单列且不计 PnL。\n`);
  console.log(`决策总数 ${verdicts.length}(ledger ${ledger.length} + 前置留痕 ${attempts.length},去重后)\n`);

  console.log(`--- 按 skip 原因分桶 ---`);
  for (const [bucket, b] of [...byBucket].sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `  ${bucket.padEnd(24)} n=${String(b.n).padStart(3)}  反事实合计 ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(2)}  (不可定价 ${b.unpriceable})`
    );
  }

  console.log(`\n--- 逐笔 ---`);
  for (const v of verdicts) {
    console.log(
      `\n[${v.at.slice(0, 19)}] ${v.status.toUpperCase()} · ${v.bucket}\n` +
        `  ${v.question.slice(0, 78)}\n` +
        `  买 ${v.outcome} | ${v.label.slice(0, 60)}\n` +
        `  原因: ${v.reason.slice(0, 110)}\n` +
        `  结算: ${v.settled == null ? "未结算/查不到" : v.settled === 1 ? "赢(1.0)" : `${v.settled}`}` +
        ` | 信号后30min真实成交: ${v.postSignalFills != null ? `${v.postSignalFills} 笔` : v.postSignalUncovered ? "不可定价" : "?"}` +
        `${v.postSignalVwap != null ? ` VWAP ${v.postSignalVwap.toFixed(3)} 额 $${v.postSignalUsd}` : ""}\n` +
        `  → ${v.counterfactualPnl != null ? `${v.counterfactualPnl >= 0 ? "+" : ""}$${v.counterfactualPnl.toFixed(2)}` : "不计价"} · ${v.note}`
    );
  }

  const priced = verdicts.filter((v) => v.counterfactualPnl != null);
  const total = priced.reduce((s, v) => s + (v.counterfactualPnl ?? 0), 0);
  const uncovered = verdicts.filter((v) => v.counterfactualPnl == null && v.postSignalUncovered);
  console.log(`\n=== 汇总 ===`);
  console.log(`可定价 ${priced.length}/${verdicts.length} 笔,合计 ${total >= 0 ? "+" : ""}$${total.toFixed(2)}`);
  if (uncovered.length > 0) {
    // 这行必须显式打出来:盲区规模不写在脸上,读者会把"不可定价"当成"没机会"
    // 顺手读成 $0,而那正是 finding 10 要堵的自我美化(2026-08-02 审计)。
    console.log(
      `其中 ${uncovered.length} 笔是"信号后窗口取不到成交"(分页上限/取数失败),` +
        `属已知盲区而非"没有机会" —— 若这个数不小,先确认代理与 data-api 可达再读结论。`
    );
  }
  console.log(
    `诚实边界:样本量极小,任何按此年化的数字都脆弱;层 2(闸门代码历史重放)` +
      `在机会落库攒满 3 周前无法做 —— 不要用残缺数据硬凑统计量。\n`
  );
}

main().catch((err) => {
  console.error(`[gonogo-materials] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
