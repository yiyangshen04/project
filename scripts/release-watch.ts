/**
 * 定时数据发布值守记录器(2026-08-05)。
 *
 * 为什么需要它:chain-watch 只听链上 UMA 事件,而"现实世界定时数据发布"
 * (CSU 飓风季预报、BLS 就业报告、CPI)在发布那一刻链上是**零前兆**的 ——
 * 官方数字先出现在某个网页/PDF 上,几秒到几分钟后才有人去 UMA 提案。
 * 这类窗口引擎完全覆盖不到,而它恰恰是我们唯一能提前知道确切时点的机会形态。
 *
 * 但在写任何"狙击器"之前,有一条我们手上完全空白的数据必须先拿到:
 *
 *   **发布之后,盘口的边际到底衰减得多快?**
 *
 * 因为 bot 是 colocation 而我们出海 200-400ms,抢发布瞬间是没有位置的
 * (2026-07-16 高频可行性研究已定论)。真正可能属于我们的是发布后的尾价
 * carry(bt3:0.90-0.995 档 n=107 胜率 100%/+3.1%)—— 而这条路值不值得
 * 自动化,完全取决于"No 侧从 0.955 爬到 0.99 用了多久"。这个数没有人告诉
 * 我们,只能自己蹲一次。
 *
 * 所以本脚本**只读、不下单、不写任何生产状态**,它只干两件事:
 *   1. 高频探测发布源 URL(HEAD),记录第一次 200 的**精确时刻**;
 *   2. 全程记录目标 event 每一条腿的 bid/ask/深度,发布后自动加密采样。
 *
 * 产出一份 JSONL,事后画出衰减曲线。今晚(CSU)当彩排验证脚本本身,周五
 * (NFP)才谈实弹 —— 拿真钱去赌一个当晚现写的脚本没 bug,是本末倒置。
 *
 * 用法(生产机必须经 run-cron.sh:它负责 .env + WSL 宿主代理解析):
 *   ./run-cron.sh scripts/release-watch.ts \
 *     --label csu \
 *     --probe https://tropical.colostate.edu/Forecast/2026-08.pdf \
 *     --event 773492 \
 *     --max-hours 10
 *
 *   # BLS(周五 NFP,两个家族一起记)
 *   ./run-cron.sh scripts/release-watch.ts --label nfp \
 *     --probe https://www.bls.gov/news.release/empsit.nr0.htm \
 *     --event 660463,660461 --probe-every 1 --max-hours 3
 *
 * 参数:
 *   --label <名>          输出文件名用,默认 watch
 *   --probe <url[,url]>   发布探测目标(HEAD);多个任一 200 即判定发布
 *   --event <id[,id]>     要记录盘口的 Gamma event id
 *   --probe-every <秒>    探测间隔,默认 3(BLS 这类精确到分钟的可以给 1)
 *   --book-every <秒>     发布前盘口采样间隔,默认 30
 *   --book-hot <秒>       发布后加密采样间隔,默认 3
 *   --hot-window <分钟>   发布后加密采样持续多久,默认 60
 *   --max-hours <小时>    总运行上限,默认 8(防跑飞)
 *   --no-fetch            发布后不把源文件抓下来存证(默认抓)
 *   --out <路径>          覆盖默认输出路径
 *   --notify              发布/数字更新时发邮件(默认关)
 *   --html-probe <url>    数字解析页(PDF 只能判"发没发",数字从 HTML 读)
 *   --extract csu-named-storms   内置解析规则(见 EXTRACTORS)
 *   --baseline <数字>     当前已知值;解析结果 ≠ 它才算"数字已更新"
 *
 * 为什么数字不从 PDF 读:生产机没有 pdftotext(装它要 root),而 CSU 首页的
 * headline 表本身就是 HTML。分工:PDF URL 用来**最快判定发没发**(它比首页
 * 早更新),HTML 用来**读数字**(可能晚几分钟)。两封邮件分开发 —— 第一封
 * "发布了,自己去看 PDF" 争的是秒,第二封"数字=N" 求的是准。
 *
 * 输出 JSONL(data/release-watch-<label>-<ts>.jsonl),每行一个事件:
 *   {kind:"start"}   启动参数快照
 *   {kind:"probe"}   仅在状态码变化 / 每 5 分钟心跳时落一行(不是每次探测都写)
 *   {kind:"release"} 首次 200 —— 这行的 at 就是我们测到的发布时刻
 *   {kind:"book"}    一次全量盘口快照
 *   {kind:"end"}     收尾(含 SIGINT/SIGTERM 优雅退出)
 */
import fs from "node:fs";
import path from "node:path";
import { CLOB_API, GAMMA_API } from "../lib/polymarket/config";

const argv = process.argv.slice(2);
/** 取值型参数。必须先 includes 再取:indexOf 未命中返回 -1,argv[-1+1] 就是
 * argv[0] —— gonogo-materials 的 --usd 踩过这个坑(2026-08-02 审计)。 */
const arg = (name: string): string | null =>
  argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? null) : null;
const num = (name: string, dflt: number): number => {
  const v = arg(name);
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const LABEL = arg("--label") ?? "watch";
const PROBE_URLS = (arg("--probe") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EVENT_IDS = (arg("--event") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PROBE_EVERY_MS = num("--probe-every", 3) * 1000;
const BOOK_EVERY_MS = num("--book-every", 30) * 1000;
const BOOK_HOT_MS = num("--book-hot", 3) * 1000;
const HOT_WINDOW_MS = num("--hot-window", 60) * 60_000;
const MAX_RUN_MS = num("--max-hours", 8) * 3600_000;
const FETCH_ON_RELEASE = !argv.includes("--no-fetch");
const NOTIFY = argv.includes("--notify");
const HTML_PROBE = arg("--html-probe");
const EXTRACT = arg("--extract");
const BASELINE = arg("--baseline");

if (PROBE_URLS.length === 0 && EVENT_IDS.length === 0) {
  console.error("用法: --probe <url[,url]> 和/或 --event <id[,id]>(至少给一个)");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const OUT =
  arg("--out") ??
  path.join(ROOT, "data", `release-watch-${LABEL}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

/** 逐行 append + 立即落盘。长跑进程随时可能被 kill(SIGTERM/断网/重启),
 * 缓冲区里的样本一旦丢掉就永远补不回来 —— 这类蹲点数据没有第二次机会。 */
function emit(row: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  fs.appendFileSync(OUT, line + "\n");
  console.log(line);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Gamma / CLOB 取数(与 watch-family.ts 同口径)──

interface GammaMarket {
  question: string;
  conditionId: string;
  clobTokenIds?: string;
  outcomes?: string;
  closed?: boolean;
  umaResolutionStatus?: string;
}
interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets?: GammaMarket[];
}
interface BookSide {
  price: string;
  size: string;
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 近档深度($):最优价往上 within 之内的可成交额。与 watch-family 一致,
 * 这样两个脚本的数字可以直接对照。 */
function depthUsd(asks: BookSide[], within = 0.05): number {
  const parsed = asks
    .map((a) => ({ p: Number(a.price), s: Number(a.size) }))
    .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.s) && x.s > 0)
    .sort((a, b) => a.p - b.p);
  if (parsed.length === 0) return 0;
  const ceil = parsed[0].p + within;
  return parsed.filter((x) => x.p <= ceil).reduce((s, x) => s + x.p * x.s, 0);
}

interface LegSnapshot {
  outcome: string;
  tokenId: string;
  bestAsk: number | null;
  bestBid: number | null;
  /** 中点。价差极宽时它只是数学中值、没有交易支撑,分析时要和 spread 一起看
   * (CSU 三档实测 spread 0.28-0.64,ask 单独读会把"共识"读高一倍)。 */
  mid: number | null;
  spread: number | null;
  askDepthUsd: number;
  askLevels: number;
  bidLevels: number;
  bookEmpty: boolean;
  /** 取数失败(超时/限流/瞬断)。必须与 bookEmpty 严格分开:两者在 JSON 里
   * 长得一样(全 null + 0 档),但含义相反 —— 一个是"此刻没人挂单",一个是
   * "我们没看到"。衰减曲线上把失败点当成深度归零,会得出"发布后 3 秒盘口
   * 被吃光"这种完全错误的结论(同 gonogo 材料里"不可定价 ≠ $0 机会成本")。 */
  fetchFailed: boolean;
}

/** event → 腿清单。tokenId 在整个值守期间不变,只解析一次,之后每轮只打 /book
 * (Gamma 每轮重查会把采样间隔拖长,而我们要测的正是秒级衰减)。 */
interface MarketPlan {
  eventId: string;
  eventTitle: string;
  question: string;
  conditionId: string;
  legs: Array<{ outcome: string; tokenId: string }>;
}

async function buildPlan(): Promise<MarketPlan[]> {
  const plans: MarketPlan[] = [];
  for (const id of EVENT_IDS) {
    const arr = await getJson<GammaEvent[] | GammaEvent>(`${GAMMA_API}/events?id=${id}`);
    const ev = Array.isArray(arr) ? arr[0] : arr;
    if (!ev) {
      emit({ kind: "warn", msg: `event ${id} 取不到,跳过` });
      continue;
    }
    for (const m of ev.markets ?? []) {
      let tokenIds: string[] = [];
      let outcomes: string[] = [];
      try {
        tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
        outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
      } catch {
        // 字段形态异常 → 该市场无腿可记,下面 length 0 会被跳过
      }
      if (tokenIds.length === 0) continue;
      plans.push({
        eventId: String(ev.id),
        eventTitle: ev.title,
        question: m.question,
        conditionId: m.conditionId,
        legs: tokenIds.map((t, i) => ({ outcome: outcomes[i] ?? `#${i}`, tokenId: t })),
      });
    }
  }
  return plans;
}

/** 一轮全量盘口。串行发请求:CLOB 有速率限制,而我们宁可采样间隔略微拉长,
 * 也不要被限流打出一段空白 —— 空白正好会落在发布后最关键的那几十秒。 */
async function snapshotBooks(plans: MarketPlan[]): Promise<Array<Record<string, unknown>>> {
  const started = Date.now();
  const markets: Array<Record<string, unknown>> = [];
  for (const p of plans) {
    const legs: LegSnapshot[] = [];
    for (const leg of p.legs) {
      // 单次重试:冒烟测试里 CLOB 出现过一次瞬时空返回。发布后每个样本都
      // 不可复得,一次 300ms 的重试远比曲线上多一个洞划算。
      const bookUrl = `${CLOB_API}/book?token_id=${leg.tokenId}`;
      let b = await getJson<{ asks?: BookSide[]; bids?: BookSide[] }>(bookUrl, 10_000);
      if (b == null) {
        await sleep(300);
        b = await getJson<{ asks?: BookSide[]; bids?: BookSide[] }>(bookUrl, 10_000);
      }
      const asks = b?.asks ?? [];
      const bids = b?.bids ?? [];
      const bestAsk =
        asks.map((a) => Number(a.price)).filter(Number.isFinite).sort((x, y) => x - y)[0] ?? null;
      const bestBid =
        bids.map((a) => Number(a.price)).filter(Number.isFinite).sort((x, y) => y - x)[0] ?? null;
      legs.push({
        outcome: leg.outcome,
        tokenId: leg.tokenId,
        bestAsk,
        bestBid,
        mid: bestAsk != null && bestBid != null ? Math.round(((bestAsk + bestBid) / 2) * 1e4) / 1e4 : null,
        spread: bestAsk != null && bestBid != null ? Math.round((bestAsk - bestBid) * 1e4) / 1e4 : null,
        askDepthUsd: Math.round(depthUsd(asks) * 100) / 100,
        askLevels: asks.length,
        bidLevels: bids.length,
        // 空 asks ≠ 接口没返回:CLOB /book 是全镜像,空 asks = taker 任何价位
        // 都不可成交(2026-08-01 飓风家族复盘结论)。这两种情况分析时不能混。
        bookEmpty: b != null && asks.length === 0,
        fetchFailed: b == null,
      });
    }
    markets.push({ eventId: p.eventId, question: p.question, conditionId: p.conditionId, legs });
  }
  emit({ kind: "book", elapsedMs: Date.now() - started, markets });
  return markets;
}

// ── 数字解析(HTML)──

/** 内置解析规则。刻意做成白名单而不是让调用方传正则:一个写错的正则会在
 * 发布那一刻静默匹配到别的数字,而这封邮件是要拿来下单的。 */
const EXTRACTORS: Record<string, { url: string; parse: (text: string) => number | null; note: string }> = {
  "csu-named-storms": {
    url: "https://tropical.colostate.edu/forecasting.html",
    // 表格顺序是「标签 → 本年预报值 → 1991-2020 均值」,实测文本:
    //   "Named Storms 9 14.4"
    // 用**均值 14.4 当锚点**校验:只匹配 "Named Storms <x> 14.4",这样即使
    // 页面改版把别的数字挪到附近,也不会误取(14.4 是气候态常数,不随年份变)。
    parse: (t) => {
      const m = /Named Storms[^\d]{0,20}([\d.]+)\s+14\.4/.exec(t);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    },
    note: "CSU headline 表 Named Storms(锚点=1991-2020 均值 14.4)",
  },
};

/** CSU 8-05 三档的映射。条款:小数四舍五入(.5 进位),区间取中点向下取整。
 * 只用于邮件里给个提示,**不驱动任何下单** —— 最终以报告 headline 表为准。 */
function csuBracket(n: number): string {
  const r = Math.round(n); // .5 进位 = JS Math.round 的行为(正数域)
  if (r <= 7) return "≤7 named storms";
  if (r === 8) return "8 named storms";
  return "≥9 named storms";
}

function stripHtml(h: string): string {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

// ── 邮件 ──

/** 发信一律 fail-open:发不出去只是少一封提醒,绝不能因此把值守进程带走
 * (蹲点数据没有第二次机会)。 */
async function notify(subject: string, html: string, text: string): Promise<void> {
  if (!NOTIFY) return;
  try {
    const { sendMail } = await import("./mailer");
    const info = await sendMail({ subject, html, text });
    emit({ kind: "mail", subject, messageId: info.messageId });
  } catch (err) {
    emit({ kind: "warn", msg: `发信失败: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** 邮件里的盘口表 —— 收到邮件的人要在 30 秒内决定点不点,给他 ask/深度/价差
 * 就够,别塞分析。 */
function bookTableHtml(markets: Array<Record<string, unknown>>): string {
  const rows: string[] = [];
  for (const m of markets) {
    for (const l of (m.legs as LegSnapshot[]) ?? []) {
      rows.push(
        `<tr><td>${m.question}</td><td>${l.outcome}</td><td align="right">${l.bestAsk ?? "—"}</td>` +
          `<td align="right">${l.bestBid ?? "—"}</td><td align="right">$${l.askDepthUsd}</td>` +
          `<td align="right">${l.spread ?? "—"}</td></tr>`
      );
    }
  }
  return (
    `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">` +
    `<tr><th>市场</th><th>腿</th><th>ask</th><th>bid</th><th>近档深度</th><th>价差</th></tr>` +
    rows.join("") +
    `</table>`
  );
}

// ── 发布探测 ──

interface ProbeState {
  url: string;
  lastStatus: number | null;
  lastLoggedAt: number;
}

/** HEAD 探测。判据是 status===200:实测 CSU 的未发布地址返回真 404(6493 字节
 * 的错误页),不是"200 + 错误页" —— 但 contentLength 一并留痕,万一某个源改成
 * 软 404,事后能从数据里看出来而不是得到一个假的发布时刻。 */
async function probeOnce(url: string): Promise<{ status: number | null; contentLength: string | null }> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    return { status: res.status, contentLength: res.headers.get("content-length") };
  } catch {
    return { status: null, contentLength: null };
  }
}

// ── 页面新鲜度(2026-08-07 CSU 复盘)──

/** 数字页的一次快照指纹。
 *
 * 病灶:extractLoop 的判据是纯数值比较(`val !== lastVal`),而 CSU 8-05 那次
 * 首页数字**发布前后都是 9** —— 整整 8 小时 extract 只落了启动那一行,
 * number-updated 零次,release-watch 对那次发布在结构上只剩 "PDF 200" 一条腿。
 * 数值比较只在数字**变了**时说话;而"页面换了一版"本身就是发布信号,与新旧
 * 数字是否相同无关。
 *
 * 用去标签后的正文长度而不是 Content-Length:后者被 gzip 协商与页内 nonce
 * 搅动(08-07 §3.1:Akamai boomerang 每轮注入 ak.rid/ak.t,整页哈希天然不可
 * 比),去标签后的长度对这类噪音稳健得多。 */
interface Freshness {
  lm: string | null;
  etag: string | null;
  textLen: number;
}

/** 与基线比,哪些信号动了。lm/etag 变动无条件算数(源站语义);正文长度设
 * 1% 门槛 —— 页脚时间戳、轮播计数这类每轮小抖动不该把值守喊起来。 */
function freshnessMoved(base: Freshness, now: Freshness): string[] {
  const moved: string[] = [];
  if (base.lm !== now.lm) moved.push("last-modified");
  if (base.etag !== now.etag) moved.push("etag");
  if (base.textLen > 0 && Math.abs(now.textLen - base.textLen) / base.textLen >= 0.01) {
    moved.push("text-length");
  }
  return moved;
}

async function fetchEvidence(url: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      emit({ kind: "warn", msg: `存证下载失败 status=${res.status} ${url}` });
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const name = `release-evidence-${LABEL}-${path.basename(new URL(url).pathname) || "index"}`;
    const dest = path.join(path.dirname(OUT), name);
    fs.writeFileSync(dest, buf);
    emit({ kind: "evidence", url, bytes: buf.length, file: dest });
  } catch (err) {
    emit({ kind: "warn", msg: `存证下载异常: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  emit({
    kind: "start",
    label: LABEL,
    probeUrls: PROBE_URLS,
    eventIds: EVENT_IDS,
    probeEveryMs: PROBE_EVERY_MS,
    bookEveryMs: BOOK_EVERY_MS,
    bookHotMs: BOOK_HOT_MS,
    hotWindowMs: HOT_WINDOW_MS,
    maxRunMs: MAX_RUN_MS,
    out: OUT,
  });

  let stopping = false;
  let releasedAt: number | null = null;
  const finish = (why: string): void => {
    if (stopping) return;
    stopping = true;
    emit({ kind: "end", why, ranMs: Date.now() - startedAt, releasedAt: releasedAt ? new Date(releasedAt).toISOString() : null });
    // 让 emit 的同步写落完再退,避免尾行截断
    process.exit(0);
  };
  process.on("SIGINT", () => finish("SIGINT"));
  process.on("SIGTERM", () => finish("SIGTERM"));

  // 启动自检信:发信链路必须**现在**就证明是活的。等发布那一刻才发现
  // SMTP 挂了,这一夜就白蹲了 —— 而那正是唯一不能重来的时刻。
  await notify(
    `✅ ${LABEL} 值守已启动`,
    `<p>探测:${PROBE_URLS.join("<br>")}</p><p>event:${EVENT_IDS.join(",") || "—"}</p>` +
      `<p>数字规则:${EXTRACT ?? "—"} · 基线:${BASELINE ?? "—"}</p>` +
      `<p>发布时会再发两封:①"已发布"(争秒) ②"数字=N"(求准)。本脚本不下单。</p>`,
    `${LABEL} 值守已启动`
  );

  const plans = EVENT_IDS.length > 0 ? await buildPlan() : [];
  if (plans.length > 0) {
    emit({
      kind: "plan",
      markets: plans.map((p) => ({ eventId: p.eventId, question: p.question, legs: p.legs.length })),
    });
  }

  const probeStates: ProbeState[] = PROBE_URLS.map((url) => ({ url, lastStatus: null, lastLoggedAt: 0 }));
  /** 最近一次盘口快照 —— 两封邮件都要带上"此刻能吃到什么",而重新取一遍
   * 会让邮件晚几秒发出去。发布那几十秒里,几秒就是全部。 */
  let lastBooks: Array<Record<string, unknown>> = [];
  let numberNotified = false;

  // 探测循环:高频但低噪音 —— 只在状态码变化或每 5 分钟心跳时落行,否则
  // 3 秒一次跑 8 小时会写出 9600 行探测噪音,把 book 样本淹掉。
  const probeLoop = async (): Promise<void> => {
    while (!stopping) {
      const roundStart = Date.now();
      for (const st of probeStates) {
        const { status, contentLength } = await probeOnce(st.url);
        const changed = status !== st.lastStatus;
        const heartbeat = Date.now() - st.lastLoggedAt > 5 * 60_000;
        if (changed || heartbeat) {
          emit({ kind: "probe", url: st.url, status, contentLength, changed });
          st.lastLoggedAt = Date.now();
        }
        st.lastStatus = status;
        if (status === 200 && releasedAt == null) {
          releasedAt = Date.now();
          emit({
            kind: "release",
            url: st.url,
            contentLength,
            msSinceStart: releasedAt - startedAt,
            note: "首次 200 —— 这是我们测到的发布时刻(非官方时刻,含探测间隔误差)",
          });
          if (FETCH_ON_RELEASE) void fetchEvidence(st.url);
          // 第一封:争秒。不等数字解析 —— 你自己打开 PDF 比脚本解析更快更准。
          void notify(
            `🔔 ${LABEL} 数据已发布 — ${new Date().toISOString()}`,
            `<p><b>发布源已上线:</b> <a href="${st.url}">${st.url}</a></p>` +
              `<p>数字请直接看报告 headline 表。下面是<b>此刻</b>的盘口(可能已在变):</p>` +
              bookTableHtml(lastBooks) +
              `<p style="color:#888;font-size:12px">数字解析中,若解析成功会再发一封。本脚本不下单。</p>`,
            `${LABEL} 已发布: ${st.url}`
          );
        }
      }
      if (Date.now() - startedAt > MAX_RUN_MS) return finish("max-hours");
      await sleep(Math.max(0, PROBE_EVERY_MS - (Date.now() - roundStart)));
    }
  };

  // 盘口循环:上一轮跑完再排下一轮(不用 setInterval)。热期一轮 15 条腿要
  // 几秒,硬定时会让请求堆积、越积越迟,反而在最需要密度的时候失去密度。
  const bookLoop = async (): Promise<void> => {
    while (!stopping) {
      const roundStart = Date.now();
      if (plans.length > 0) lastBooks = await snapshotBooks(plans);
      const hot = releasedAt != null && Date.now() - releasedAt < HOT_WINDOW_MS;
      const target = hot ? BOOK_HOT_MS : BOOK_EVERY_MS;
      if (Date.now() - startedAt > MAX_RUN_MS) return finish("max-hours");
      await sleep(Math.max(0, target - (Date.now() - roundStart)));
    }
  };

  // 数字解析循环:全程都跑(不是等 release 之后才开始)—— 首页有可能先于
  // PDF 更新,那样我们靠"数字变了"同样能判定发布,两条腿互为兜底。
  // 判据是**值 ≠ baseline**,不是"解析到了":页面上现在就挂着旧值 9,
  // 用"解析到了"当判据会在启动第一秒就误报。
  const extractLoop = async (): Promise<void> => {
    const spec = EXTRACT ? EXTRACTORS[EXTRACT] : null;
    if (EXTRACT && !spec) {
      emit({ kind: "warn", msg: `未知 --extract ${EXTRACT},可选:${Object.keys(EXTRACTORS).join(",")}` });
      return;
    }
    if (!spec) return;
    const url = HTML_PROBE ?? spec.url;
    const baseline = BASELINE != null ? Number(BASELINE) : null;
    let lastVal: number | null = null;
    /** 启动那一轮的页面指纹 = 基线(启动时页面必然是"发布前"那一版)。 */
    let baseFresh: Freshness | null = null;
    let lastFresh: Freshness | null = null;
    let freshNotified = false;
    while (!stopping) {
      const roundStart = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const plain = stripHtml(await res.text());
          const fresh: Freshness = {
            lm: res.headers.get("last-modified"),
            etag: res.headers.get("etag"),
            textLen: plain.length,
          };
          if (baseFresh == null) {
            baseFresh = fresh;
            emit({ kind: "page-baseline", url, ...fresh });
          } else {
            // 逐轮留痕相对**上一轮**的变动(量小、便于事后重建时间线),
            // 而告警判据取相对**基线** —— 页面来回抖动不该反复喊人。
            if (lastFresh && freshnessMoved(lastFresh, fresh).length > 0) {
              emit({ kind: "page-drift", url, from: lastFresh, to: fresh });
            }
            const moved = freshnessMoved(baseFresh, fresh);
            if (moved.length > 0 && !freshNotified) {
              freshNotified = true;
              emit({ kind: "page-updated", url, moved, from: baseFresh, to: fresh });
              // 与"已发布"同级的争秒信,但明说是弱证据:页面换版≠数字已出,
              // 也可能是编辑排版。收信人自己开 PDF 比脚本判读快。
              void notify(
                `🔶 ${LABEL} 数字页已换版(${moved.join("/")}) — ${new Date().toISOString()}`,
                `<p><b>页面新鲜度变动:</b> <a href="${url}">${url}</a></p>` +
                  `<p>变动信号:<b>${moved.join(" / ")}</b><br>` +
                  `Last-Modified ${baseFresh.lm ?? "—"} → ${fresh.lm ?? "—"}<br>` +
                  `正文长度 ${baseFresh.textLen} → ${fresh.textLen}</p>` +
                  `<p style="color:#b45309;font-size:12px">⚠ 这是弱证据:页面换版不等于数字已更新` +
                  `(CSU 8-05 首页数字发布前后都是 9,纯数值比较整夜零响,故补这条腿)。` +
                  `以 PDF 与 headline 表原文为准。本脚本不下单。</p>` +
                  `<p>此刻盘口:</p>` +
                  bookTableHtml(lastBooks),
                `${LABEL} 数字页已换版(${moved.join("/")}): ${url}`
              );
            }
          }
          lastFresh = fresh;
          const val = spec.parse(plain);
          if (val !== lastVal) {
            emit({ kind: "extract", url, value: val, baseline, rule: EXTRACT, note: spec.note });
            lastVal = val;
          }
          if (val != null && baseline != null && val !== baseline && !numberNotified) {
            numberNotified = true;
            const bracket = EXTRACT === "csu-named-storms" ? csuBracket(val) : null;
            emit({ kind: "number-updated", value: val, baseline, bracket });
            await notify(
              `🎯 ${LABEL} 数字已更新: ${val}(原 ${baseline})${bracket ? ` → ${bracket}` : ""}`,
              `<h2 style="margin:0 0 8px">${spec.note}</h2>` +
                `<p style="font-size:22px;margin:4px 0"><b>${val}</b> <span style="color:#888;font-size:14px">(此前 ${baseline})</span></p>` +
                (bracket
                  ? `<p>按 8-05 条款推算命中档位:<b>${bracket}</b><br>` +
                    `<span style="color:#b45309;font-size:12px">⚠ 仅供参考,以报告 headline 表原文为准 —— 本行不驱动任何下单</span></p>`
                  : "") +
                `<p>来源:<a href="${url}">${url}</a></p>` +
                `<p>此刻盘口:</p>` +
                bookTableHtml(lastBooks) +
                `<p><a href="https://polymarket.com/event/atlantic-named-storms-forecast-for-2026-20260730135452992">→ 打开市场</a></p>`,
              `${LABEL} 数字=${val}(原 ${baseline})${bracket ? ` → ${bracket}` : ""}`
            );
          }
        }
      } catch {
        // 页面瞬断:留给下一轮,绝不中断值守
      }
      if (Date.now() - startedAt > MAX_RUN_MS) return finish("max-hours");
      // 数字页比 PDF 慢半拍,没必要 3 秒一轮;发布后加密到 5 秒。
      const target = releasedAt != null ? 5_000 : 20_000;
      await sleep(Math.max(0, target - (Date.now() - roundStart)));
    }
  };

  await Promise.all([
    probeLoop(),
    plans.length > 0 ? bookLoop() : Promise.resolve(),
    EXTRACT ? extractLoop() : Promise.resolve(),
  ]);
  finish("loops-exited");
}

main().catch((err) => {
  emit({ kind: "fatal", msg: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
