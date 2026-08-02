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
 *         把它算成"错过的钱"是自欺欺人。
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

const ROOT = path.resolve(__dirname, "..");
const GAMMA = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const NOTIONAL = Number(argv[argv.indexOf("--usd") + 1]) || 50;
/** 数据目录覆盖。生产账本在 sufe(`ssh sufe "cat ~/prededge/data/xxx" > 本地`),
 * 拉下来之后用 --dir 指向那个目录跑,不必污染本地 data/。 */
const DATA_DIR = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : null;

interface LedgerRow {
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
}

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

/** 结算结果:返回该 outcome 名对应的结算价(1 = 赢,0 = 输,null = 未结算/查不到)。
 * 存量查询必须带 closed=true —— 不带的话已关闭市场直接查不到(既有血泪)。 */
async function settledPriceFor(conditionId: string, outcome: string): Promise<number | null> {
  const arr = await getJson<GammaMarketLite[]>(
    `${GAMMA}/markets?condition_ids=${conditionId}&closed=true`
  );
  const m = arr?.[0];
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
}

/** 信号时点之后该市场真实成交过的最优可得买价与可吃量。
 * 只认 data-api 真实成交 —— prices-history 的占位价幻象已被 bt3 实锤
 * (旧 +136% 结论半数是幻象)。 */
async function realFillsAfter(
  conditionId: string,
  outcome: string,
  afterMs: number,
  windowMs = 30 * 60_000
): Promise<{ n: number; vwap: number | null; usd: number } | null> {
  const arr = await getJson<TradeLite[]>(`${DATA_API}/trades?market=${conditionId}&limit=1000`);
  if (!arr) return null;
  const lo = afterMs / 1000;
  const hi = (afterMs + windowMs) / 1000;
  const hits = arr.filter(
    (t) =>
      t.timestamp >= lo &&
      t.timestamp <= hi &&
      String(t.outcome).trim().toLowerCase() === outcome.trim().toLowerCase()
  );
  if (hits.length === 0) return { n: 0, vwap: null, usd: 0 };
  const usd = hits.reduce((s, t) => s + t.price * t.size, 0);
  const shares = hits.reduce((s, t) => s + t.size, 0);
  return { n: hits.length, vwap: shares > 0 ? usd / shares : null, usd };
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

  // 合并两个来源:ledger 是 executeSignal 必写的,trade-attempts 覆盖前置 skip
  // (那些分支在 executeSignal 之前 return,ledger 里根本没有对应行)。
  const seen = new Set<string>();
  const rows: LedgerRow[] = [];
  for (const r of [...ledger, ...attempts]) {
    const key = `${r.at?.slice(0, 16)}|${r.tokenId ?? r.token}|${r.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));

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
      if (fills) {
        base.postSignalFills = fills.n;
        base.postSignalVwap = fills.vwap;
        base.postSignalUsd = Math.round(fills.usd * 100) / 100;
      }
    }
    if (r.status === "filled" || r.status === "partial") {
      // 已成交:真实盈亏,不是反事实。
      if (base.settled != null && r.filledUsd != null && r.avgPrice) {
        const shares = r.filledUsd / r.avgPrice;
        base.counterfactualPnl =
          Math.round((shares * base.settled - r.filledUsd - (r.feeUsd ?? 0)) * 100) / 100;
        base.note = "已成交(真实盈亏,非反事实)";
      }
    } else if (bucket === "空盘(物理不可成交)") {
      base.note = "空盘:taker 任何价位不可成交,不计入错过的钱(计入即自欺)";
    } else if (base.settled == null) {
      base.note = "尚未结算,无法核算";
    } else if (!base.postSignalFills) {
      base.note = "信号后窗口内零真实成交 —— 想做也做不成,机会成本 ≈ $0";
    } else if (base.postSignalVwap != null) {
      const shares = Math.min(NOTIONAL, base.postSignalUsd ?? 0) / base.postSignalVwap;
      base.counterfactualPnl =
        Math.round((shares * base.settled - shares * base.postSignalVwap) * 100) / 100;
      base.note = `反事实:按信号后 30min 内真实成交 VWAP ${base.postSignalVwap.toFixed(3)} 吃 $${Math.min(NOTIONAL, base.postSignalUsd ?? 0).toFixed(0)}(受该窗口真实成交额约束)`;
    }
    verdicts.push(base);
  }

  const byBucket = new Map<string, { n: number; pnl: number; unpriceable: number }>();
  for (const v of verdicts) {
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
        ` | 信号后30min真实成交: ${v.postSignalFills ?? "?"} 笔` +
        `${v.postSignalVwap != null ? ` VWAP ${v.postSignalVwap.toFixed(3)} 额 $${v.postSignalUsd}` : ""}\n` +
        `  → ${v.counterfactualPnl != null ? `${v.counterfactualPnl >= 0 ? "+" : ""}$${v.counterfactualPnl.toFixed(2)}` : "不计价"} · ${v.note}`
    );
  }

  const priced = verdicts.filter((v) => v.counterfactualPnl != null);
  const total = priced.reduce((s, v) => s + (v.counterfactualPnl ?? 0), 0);
  console.log(`\n=== 汇总 ===`);
  console.log(`可定价 ${priced.length}/${verdicts.length} 笔,合计 ${total >= 0 ? "+" : ""}$${total.toFixed(2)}`);
  console.log(
    `诚实边界:样本量极小,任何按此年化的数字都脆弱;层 2(闸门代码历史重放)` +
      `在机会落库攒满 3 周前无法做 —— 不要用残缺数据硬凑统计量。\n`
  );
}

main().catch((err) => {
  console.error(`[gonogo-materials] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
