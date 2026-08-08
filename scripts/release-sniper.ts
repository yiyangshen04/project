/**
 * 定时数据发布狙击器 —— CSU 2026-08-05 专用(旁侧脚本,不接入 cron/主流程)。
 *
 * 与 release-watch.ts 的关系:那个只记录,这个会**真下单**。两者可以同时跑
 * (watch 负责衰减曲线,sniper 负责成交),互不干扰。
 *
 * ── 它解决的问题 ────────────────────────────────────────────────
 * CSU 8 月预报今晚发布,发布那一刻答案就是算术确定的(headline 表 Named
 * Storms 落进 ≤7 / 8 / ≥9 三档之一)。这个盘冷到 colocation bot 大概率不来
 * (总成交 $7/$0/$2,020,价差 62 个点),所以发布后 ask 侧挂单很可能还在原地
 * —— 那就是我们能吃到的边际。人守到凌晨不现实,交给进程。
 *
 * ── 唯一能亏钱的场景,以及针对它的 ②∧③ 确认 ────────────────────
 * 数据出来后买对腿,市场风险为零。真正的 −100% 只有一条路径:
 * **页面还没更新时读到旧数字,照着旧数字下单**。
 * (今天早上那条 Macron 市场是另一条:UMA 提案错了。这条我们防不了,只能
 *  靠仓位小 —— 两周内已实证两次,见 08-03 Putin 揭盲。)
 *
 * 开火判据(2026-08-07 改,落码 08-06 定调"风险预算从确认强度搬到仓位"):
 *   ② 首页已刷新      —— forecasting.html 的 Last-Modified 相对启动时已变
 *   ③ 数字双读一致    —— 同一解析值持续 ≥ --stable 秒
 * **②∧③ 即以正常金额开火**;两条缺一不下单,只发邮件转人工。
 *   ① PDF 已上线      —— 从开火前置降级为**事后纠错信号**:开火后若 PDF
 *      超过 PDF_POST_FIRE_ALERT_MS 仍不 200,发告警转人工 —— 首单拦不住
 *      (仅 --usd),人工 touch data/trading-halt 能拦住剩余补仓(每轮
 *      executeSignal 都查 halt 文件)。
 *
 * ① 为什么降级(08-05 CSU 实测 + 08-07 核验修订 §7.1):
 *   · "PDF 必然早于首页"这条时序假设被实测证伪 —— 首页领先 PDF **37 秒**,
 *     ①∧② 的现实含义是"永远等最慢的那条腿";竞争者 0x2fdb 在页面更新
 *     15s 后扫光 0.727,根本没等 PDF。核验实测:去掉 ① 后确认时点
 *     t≈+7.5-8s(原 +13s),单次反事实代价 $33。
 *   · ① 防的洞("页面因无关原因刷新、LM 变了但 headline 还是旧值")仍然
 *     存在,残余风险按 08-06 定调交给仓位承担(--usd 量级),不再交给闸门。
 *   (08-05 曾讨论 ①② 二选一并否掉 —— 那是 OR 语义,两个洞同时敞开;
 *    本次不是二选一,是 ① 整个移出开火路径、转事后核对,论证不同,别回抄。)
 *
 * 注意 ② 为什么不能省:CSU 完全可能**维持 9 不变**,这时"数字变了"永远
 * 等不到,而 ≥9 才是正确答案。用 Last-Modified 判"页面新鲜度"而不是用
 * "数字变化"判,才能把"新报告仍是 9"和"页面没更新"区分开。
 *
 * ── 提速:HEAD 轮询(2026-08-05)────────────────────────────────
 * 延迟大头从来不是 ③ 的 5 秒,是轮询间隔。原实现每轮 GET 159KB 全页,只能
 * 10s/4s 一轮,端到端期望 ~13s(最坏 18s)。改成每轮只 HEAD 拿
 * Last-Modified(几百字节),变了才 GET 全页 —— 2s/1s 一轮,端到端 ~6.5s,
 * 比"砍掉③但不提速"还快,当时的三道确认一条没丢(08-07 起 ① 已按
 * 08-06 定调移出开火路径,见上文;提速结论不受影响)。
 * 启动时会验证 HEAD 与 GET 的 Last-Modified 是否一致,不一致就自动退回
 * 每轮 GET(fail-safe:宁可慢,不可因为 HEAD 不可信而漏判或误判)。
 *
 * ── 解析失败:LLM 降级 + 人工告警(2026-08-05)──────────────────
 * 正则只认 "Named Storms <值> 14.4" 一种排版,而 8 月报告 headline 表结构
 * 确定会变(7 月版 9 = 已观测 1 + 剩余 8,8 月版是已观测 2 + 新剩余)。多
 * 一个数字或改成区间排版,正则就完全不匹配 —— fail-closed 不会买错,但会
 * **静默错过**:报告发了、页面刷了、数字就在屏幕上,而人在睡觉。
 * 于是三条兜底,**严格按这个顺序**(便宜的先上):
 *   1. 正则梯队 —— 换一种排版再读一次。四层 exact/range/multicol/loose,
 *      每层都锚定 14.4,微秒级。见 parseNamedStormsTiered
 *   2. 转 Opus 读数(lib/polymarket/llmStance.extractNumberWithLlm),要求
 *      逐字引文命中页面 + 引文里确实含该数字 + 落在 [0,30] + **两个并发独立
 *      调用读到同一个值**。并发不串行:双读要的是两次独立推理互为对照,
 *      不是时间间隔,所以耗时 ≈ 单次。它是唯一能挡"读错行"的机制 —— 引文
 *      校验只证明"引的那段真在页面里、报的数真在引文里",证明不了读的是
 *      Named Storms 那行而不是隔壁 Hurricanes。两路不一致一律拒绝下单
 *   3. 并发双读也没结果 → 立刻发一封人工告警邮件,不等 11 小时超时那封
 * 为什么正则在前:LLM 一轮 5-9 秒,而正则是微秒级 —— 能用正则解决的排版
 * 变化不该拖进 LLM,那是拿窗口换冗余。
 * 后两级都不放松任何下单闸门:仍要过 bracketFor 唯一命中、--arm、
 * --max-price、executeSignal 全套风控;非 exact 层命中还会先发一封标注邮件。
 *
 * ── 档位映射:精确文本绑定,fail-closed ──────────────────────────
 * 三档的 question 原文写死在 BRACKETS 里。启动时逐条比对 Gamma 返回的
 * question,**任何一条对不上就拒绝启动**。bucket 映射是 07-10 审计点名的
 * "硬错误集中地",这里用"文本不匹配即停机"换掉启发式。
 *
 * ── 风控 ────────────────────────────────────────────────────────
 * 下单一律走 lib/polymarket/tradeExecutor.executeSignal:kill-switch、
 * 连亏熔断、价格带、漂移带/暴跌守卫、per-token 与同事件敞口帽、日/总额度
 * 原样生效。本脚本**额外**加两道更严的闸:
 *   · --arm    不给就强制 dry(即使 .env 里 EXEC_MODE=live 也不下单)
 *   · --max-price  超过就不买(默认 0.90)。bot 若已把价推到 0.97,那笔
 *                  边际只剩 3%,不值得为它承担解析风险 —— 放弃是正确答案。
 *
 * ── --max-price 到底封住了什么(2026-08-07 核验修订)────────────
 * 它是一道**追高闸**,不是"成交均价上限"。旧文档把它压缩成"价格上限",
 * 那句话在生产上是假的:它硬 return 的判据是**下单前那一刻的 ask**,而
 * executeSignal 会在自己那一侧重拉一次盘口(freshAsk),再在 freshAsk 之上
 * 按滑点带算出 limitPrice —— 两者都可以高过 --max-price。
 * EXEC_MAX_PRICE 从 0.97 抬到 0.995 之后,最坏路径由 +2.0 分变成 +4.5 分。
 *
 * 修法不能是"把 EXEC_MAX_PRICE 钉成 --max-price":实测
 * limitPriceFor(0.95, declarative, {maxPrice: 0.95}) = 0.95 = freshAsk 本身
 * → 滑点带归零,FAK 只能吃簿顶那一档;ledger #108 那 $44 的绝大部分来自
 * 0.95 以上的档位,那么钉等于把成交量砍掉。
 * 所以钉的是 **--max-price + 滑点带**(maxPriceCap,只收紧不放宽):
 * 最坏成交价 = --max-price + EXEC_SLIPPAGE,语义写得出、算得准,滑点带
 * 完整保留。成交后再对 avgPrice 做一次事后核对,超了就告警留痕。
 *
 * ── 补仓(2026-08-02 那批的复访语义,这里按秒级窗口重调)────────
 * 第一笔成交后,卖家/bot 补货不会再触发任何信号,引擎必须自己回头看。
 * 成交即进本进程内的复访循环,每 --refill-every 秒重试一次,共
 * --refill-tries 次,每次都完整再过一遍 executeSignal 的全部风控
 * (补仓量由 perTokenMaxUsd − 已有敞口封死,不会放大总风险)。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   # 干跑(默认,不下单;先用它确认映射与 ②∧③ 开火逻辑)
 *   ./run-cron.sh scripts/release-sniper.ts --event 773492 --usd 30
 *
 *   # 实弹:必须显式 --arm
 *   ./run-cron.sh scripts/release-sniper.ts --event 773492 --usd 30 --arm
 *
 *   # 自检:强制走一遍映射+下单路径(用 --simulate <数字>,不碰真金)
 *   ./run-cron.sh scripts/release-sniper.ts --event 773492 --simulate 8
 *
 * 参数:
 *   --event <id>          Gamma event id(CSU 家族 = 773492)
 *   --usd <金额>          单笔名义额,默认 30
 *   --max-price <价>      追高闸,默认 0.90:信号时刻 ask 高于此价即放弃。
 *                         最坏成交价 = 此价 + EXEC_SLIPPAGE(见上文修订说明)
 *   --arm                 实弹开关。不给 = 全程 dry,只演不买
 *   --simulate <数字>     跳过等待,假装解析到该数字(自检用;仍受 --arm 约束)
 *   --refill-tries <次>   成交后补仓重试次数,默认 8
 *   --refill-every <秒>   补仓重试间隔,默认 20
 *   --poll-cold <秒>      发布前轮询间隔(HEAD,很轻),默认 2
 *   --poll-hot <秒>       出现信号后的轮询间隔,默认 1
 *   --stable <秒>         ③ 稳定期:同值持续多久才认,默认 2(与轮询是两回事)
 *   --no-head-fast        禁用 HEAD 快路,每轮都 GET 全页(排障用)
 *   --no-llm              禁用正则失败后的 LLM 降级读数
 *   --max-hours <小时>    总运行上限,默认 11
 *   --no-mail             不发邮件
 */
import fs from "node:fs";
import path from "node:path";
import { CLOB_API, GAMMA_API } from "../lib/polymarket/config";
import { executeSignal, executionMode } from "../lib/polymarket/tradeExecutor";
import type { TradeAttempt } from "../lib/polymarket/tradeExecutor";
import { extractNumberWithLlm } from "../lib/polymarket/llmStance";

const argv = process.argv.slice(2);
const arg = (n: string): string | null => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? null) : null);
const num = (n: string, d: number): number => {
  const v = arg(n);
  if (v == null) return d;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
};

const EVENT_ID = arg("--event") ?? "773492";
const USD = num("--usd", 30);
const MAX_PRICE = num("--max-price", 0.9);
/** --max-price 之上还允许的滑点带 = executeSignal 会用的那一条(默认 0.03)。
 * 执行侧的帽钉在 MAX_PRICE + 这一条:既守住"最坏成交价说得出口"的纪律,
 * 又不像直接钉 MAX_PRICE 那样把滑点带压成 0(那会让 FAK 只吃簿顶一档)。 */
const EXEC_SLIPPAGE = (() => {
  const v = Number(process.env.EXEC_SLIPPAGE);
  return Number.isFinite(v) && v >= 0 ? v : 0.03;
})();
/** 传给 executeSignal 的独立价格帽。它同时封住 freshAsk 与 limitPrice ——
 * --max-price 那道硬 return 只封得住信号时刻的 ask。 */
const EXEC_PRICE_CAP = Math.min(0.999, MAX_PRICE + EXEC_SLIPPAGE);
const ARMED = argv.includes("--arm");
const SIMULATE = arg("--simulate") != null ? Number(arg("--simulate")) : null;
const REFILL_TRIES = num("--refill-tries", 8);
const REFILL_EVERY_MS = num("--refill-every", 20) * 1000;
const POLL_COLD_MS = num("--poll-cold", 2) * 1000;
const POLL_HOT_MS = num("--poll-hot", 1) * 1000;
/** ③ 的稳定期门槛:同一个值要持续这么久才认。与轮询间隔是两回事 ——
 * 轮询是"多久看一次",这个是"看到同一个值多久才信"。 */
const STABLE_MS = num("--stable", 2) * 1000;
const HEAD_FAST = !argv.includes("--no-head-fast");
const LLM_FALLBACK = !argv.includes("--no-llm");
const MAX_RUN_MS = num("--max-hours", 11) * 3600_000;
const MAIL = !argv.includes("--no-mail");

/** ① 的事后纠错窗口:开火时 PDF 未上线,超过这么久仍不 200 → 告警转人工。
 * 08-05 实测正常时差 = 首页领先 PDF 37s,3 分钟 ≈ 5 倍余量;超过即形态可疑
 * (首页可能是无关刷新),人工 touch trading-halt 拦剩余补仓。 */
const PDF_POST_FIRE_ALERT_MS = 3 * 60_000;

/** ②∧③ 开火判据(导出供离线测试锁行为)。2026-08-07:pdfLive 从开火前置
 * 条件中移除(08-06 定调落码,①降级为事后纠错)—— 这正是"行为从 ①∧②∧③
 * 变成 ②∧③"的那一刀,tests/releaseSniper.test.ts 按它断言;谁改回
 * pdfLive 前置,测试会在这里响。② 由调用方保证(本函数只在 freshPage
 * 分支内被调用),③ 是 stableMs 门槛。 */
export function fireGate(input: { stableMs: number; stableThresholdMs: number; pdfLive: boolean }): {
  fire: boolean;
  /** 开火但 ① 还没兑现 —— fireAndRefill 要带起事后纠错 watcher。 */
  watchPdf: boolean;
} {
  const fire = input.stableMs >= input.stableThresholdMs;
  return { fire, watchPdf: fire && !input.pdfLive };
}

/** 额度 env 钉法(导出供离线测试;main 里原样应用)。只提供默认、不覆盖
 * 显式配置;单笔只收紧不放宽(min(--usd, env))。
 * per-event 为什么必须一起钉(2026-08-07 核验 §1.4 暴露):
 * EXEC_PER_EVENT_MAX_USD 默认 = 2×EXEC_MAX_ORDER_USD,在 executeSignal 的
 * min() 里先于 per-token 咬住 —— 只钉 per-token 时,USD*4 的补仓容量实际
 * 永远只有 USD*2(08-05 CSU $165 成交离 $200 帽只差 $35)。事件帽防的是
 * "一条澄清打 N 个兄弟腿 = 同一判断放大 N 倍"(chain-watch 语义),对本
 * 脚本不成立:三档互斥、只买命中的那一条腿,事件帽在此退化为一道更严的
 * token 帽,与 per-token 对齐即可。 */
export function execCapPins(
  usd: number,
  // Record 而非具名字段接口:process.env 是索引签名类型,与"无公共具名属性"
  // 的字面量接口不兼容(TS2559);测试里的对象字面量两种写法都可赋值。
  env: Record<string, string | undefined>
): { maxOrder: string; perToken: string; perEvent: string } {
  const envMax = Number(env.EXEC_MAX_ORDER_USD ?? "50");
  return {
    maxOrder: String(Math.min(usd, Number.isFinite(envMax) ? envMax : usd)),
    perToken: env.EXEC_PER_TOKEN_MAX_USD ?? String(usd * 4),
    perEvent: env.EXEC_PER_EVENT_MAX_USD ?? String(usd * 4),
  };
}

/** LLM 读数的最小间隔 —— 纯限流,**不再兼任双读的间隔**(见下)。
 * 防的是"页面已刷新但排版怪到四层正则和 LLM 都读不出"时,每轮都烧 Opus,
 * 把 11 小时窗口烧成一堆超时。一次触发发两个并发调用,30s 限流 = 每分钟
 * 最多 4 个调用,够用且不失控。 */
const LLM_GAP_MS = 30_000;

const PDF_URL = "https://tropical.colostate.edu/Forecast/2026-08.pdf";
const HTML_URL = "https://tropical.colostate.edu/forecasting.html";

/** 三档的 question 原文 + 判定谓词。启动时逐条精确比对,对不上就停机。
 * 谓词入参是**四舍五入后的整数**(条款:小数 .5 进位;区间取中点向下取整)。 */
const BRACKETS: Array<{ question: string; hit: (n: number) => boolean; short: string }> = [
  { question: "Will CSU forecast 7 or fewer named storms?", hit: (n) => n <= 7, short: "≤7" },
  { question: "Will CSU forecast 8 named storms?", hit: (n) => n === 8, short: "=8" },
  { question: "Will CSU forecast 9 or more named storms?", hit: (n) => n >= 9, short: "≥9" },
];

/** 导出供离线测试:边界值必须全部走通再上实弹。 */
export function bracketFor(raw: number): { short: string; question: string } | null {
  const n = Math.round(raw); // 正数域下 Math.round 即 .5 进位
  const hits = BRACKETS.filter((b) => b.hit(n));
  // 谓词集必须恰好命中一个 —— 命中 0 个或 ≥2 个都说明表写错了,fail-closed。
  if (hits.length !== 1) return null;
  return { short: hits[0].short, question: hits[0].question };
}

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", `release-sniper-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`);

/** 目录在首次落行时才建 —— 顶层建目录会让 tests/releaseSniper.test.ts
 * 仅仅 import bracketFor 就产生文件系统副作用。 */
let outReady = false;
function emit(row: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  if (!outReady) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    outReady = true;
  }
  fs.appendFileSync(OUT, line + "\n");
  console.log(line);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function notify(subject: string, html: string): Promise<void> {
  if (!MAIL) return;
  try {
    const { sendMail } = await import("./mailer");
    const info = await sendMail({ subject, html, text: subject });
    emit({ kind: "mail", subject, messageId: info.messageId });
  } catch (err) {
    // fail-open:发不出信绝不能影响下单路径
    emit({ kind: "warn", msg: `发信失败: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ── 取数 ──

interface GammaMarket {
  question: string;
  conditionId: string;
  questionID?: string;
  clobTokenIds?: string;
  outcomes?: string;
  slug?: string;
  closed?: boolean;
  negRisk?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number };
  endDate?: string;
}

async function getJson<T>(url: string, ms = 20_000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Leg {
  short: string;
  question: string;
  qid: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  marketUrl: string | null;
  negRisk: boolean;
  feesEnabled: boolean | null;
  feeRate: number | null;
  endDate: string | null;
}

/** 只取每个市场的 **Yes** 腿:命中档买 Yes 是唯一需要的方向。
 * (买未命中档的 No 也可行,但那要同时判两条腿、出错面翻倍,今晚不做。) */
async function buildLegs(): Promise<Map<string, Leg> | null> {
  const arr = await getJson<Array<{ id: string; title: string; markets?: GammaMarket[] }>>(
    `${GAMMA_API}/events?id=${EVENT_ID}`
  );
  const ev = arr?.[0];
  if (!ev) {
    emit({ kind: "fatal", msg: `event ${EVENT_ID} 取不到` });
    return null;
  }
  const byQuestion = new Map<string, GammaMarket>();
  for (const m of ev.markets ?? []) byQuestion.set(m.question.trim(), m);

  const legs = new Map<string, Leg>();
  for (const b of BRACKETS) {
    const m = byQuestion.get(b.question);
    if (!m) {
      // 文本对不上 = 映射不可信 = 停机。这是本脚本唯一的启动硬门槛。
      emit({
        kind: "fatal",
        msg: `档位文本不匹配,拒绝启动。期望:"${b.question}";实际清单:${[...byQuestion.keys()].join(" | ")}`,
      });
      return null;
    }
    let tokenIds: string[] = [];
    let outcomes: string[] = [];
    try {
      tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
      outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
    } catch {
      emit({ kind: "fatal", msg: `${b.question} 的 token/outcome 字段解析失败` });
      return null;
    }
    const yesIdx = outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
    if (yesIdx < 0 || !tokenIds[yesIdx]) {
      emit({ kind: "fatal", msg: `${b.question} 找不到 Yes 腿(outcomes=${JSON.stringify(outcomes)})` });
      return null;
    }
    if (!m.questionID) {
      emit({ kind: "fatal", msg: `${b.question} 缺 questionID(ledger 去重键)` });
      return null;
    }
    legs.set(b.short, {
      short: b.short,
      question: m.question,
      qid: m.questionID,
      conditionId: m.conditionId,
      tokenId: tokenIds[yesIdx],
      outcome: outcomes[yesIdx],
      marketUrl: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
      negRisk: m.negRisk === true,
      feesEnabled: m.feesEnabled ?? null,
      feeRate: typeof m.feeSchedule?.rate === "number" ? m.feeSchedule.rate : null,
      endDate: m.endDate ?? null,
    });
  }
  return legs;
}

async function bestAskOf(tokenId: string): Promise<number | null> {
  const b = await getJson<{ asks?: Array<{ price: string; size: string }> }>(
    `${CLOB_API}/book?token_id=${tokenId}`,
    10_000
  );
  const asks = (b?.asks ?? []).map((a) => Number(a.price)).filter(Number.isFinite).sort((x, y) => x - y);
  return asks[0] ?? null;
}

// ── 发布确认(②页面新鲜度 ∧ ③双读稳定;① PDF 为事后纠错)──

function stripHtml(h: string): string {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** 合理性闸:大西洋季命名风暴数历史极值也在 30 以内。越界 = 解析错了。 */
function sane(n: number): number | null {
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : null;
}

/** 锚点 = 1991-2020 气候态均值 14.4(常数,不随年份变)。只认
 * "Named Storms <值> 14.4" 这个相邻组合,页面改版挪走别的数字也不会误取。 */
export function parseNamedStorms(text: string): number | null {
  const m = /Named Storms[^\d]{0,20}([\d.]+)\s+14\.4/.exec(text);
  if (!m) return null;
  return sane(Number(m[1]));
}

export interface StormReading {
  value: number;
  /** 命中的层级,留痕 + 邮件里标注 —— 非 exact 就该让人看一眼。 */
  tier: "exact" | "range" | "multicol" | "loose";
  /** 页面上的原始形态("9" / "8-10"),留痕用。 */
  raw: string;
}

/**
 * 正则梯队(2026-08-05):主正则读不出时**先换一种读法,再考虑 LLM**。
 * LLM 一轮 5-9 秒(并发双读,耗时 ≈ 单次),正则是微秒级 —— 能用正则解决的
 * 排版变化不该拖进 LLM。
 *
 * 铁律:**每一级都必须锚定 14.4**。这个锚是 1991-2020 气候态均值,是常数、
 * 且只出现在 headline 表的气候态列;丢掉它就退化成"在页面上随便抓个数",
 * 那比 LLM 危险得多 —— LLM 至少还要过逐字引文校验。所以下面四级放宽的只是
 * "标签与数值之间允许出现什么",紧邻 14.4 取值这一点从头到尾没动。
 *
 * 顺序即优先级,第一个命中的即采信:
 *   exact    "Named Storms 9 14.4"                  ← 7 月版实际排版
 *   range    "Named Storms 8-10 14.4" / "8 to 10"   ← 条款专门写了区间规则
 *   multicol "Named Storms 2 7 9 14.4"              ← 8 月版最可能的变化
 *   loose    "Named Storms (observed 2) 9 14.4"     ← 插了文字注释
 *
 * 顺序安全性(已在 tests/releaseSniperLlm.test.ts 逐条钉住):严格级匹配不到
 * 的形态,宽松级才有机会;反过来严格级能匹配的,宽松级读出的是同一个数。
 * 唯一需要排序保护的是 range —— loose 对 "8-10 14.4" 会取到上界 10,所以
 * range 必须排在 loose 前面先把区间形态识别掉。
 */
export function parseNamedStormsTiered(text: string): StormReading | null {
  const exact = parseNamedStorms(text);
  if (exact != null) return { value: exact, tier: "exact", raw: String(exact) };

  // range:"8-10" / "8 – 10" / "8 to 10"。中点向下取整 —— 条款是"区间取中点
  // 向下取整",而 bracketFor 用 Math.round(".5 进位"),两条规则在 x.5 上结论
  // 相反(8-9 → floor 8 落 "=8",round 8.5 落 "≥9"),换算必须在这里做完。
  const r = /Named Storms[^\d]{0,20}([\d.]+)\s*(?:[-–—]|\bto\b)\s*([\d.]+)\s+14\.4/.exec(text);
  if (r) {
    const lo = sane(Number(r[1]));
    const hi = sane(Number(r[2]));
    if (lo != null && hi != null && lo <= hi) {
      return { value: Math.floor((lo + hi) / 2), tier: "range", raw: `${r[1]}-${r[2]}` };
    }
    return null; // 区间形态已识别但端点不合理 → fail-closed,不要落到更宽松的层去猜
  }

  // multicol:标签与锚之间只允许数字/空白(如"已观测 剩余 全季"三列),
  // 惰性量词保证取到的是**紧邻 14.4 的那个**,也就是全季总数那一列。
  const m = /Named Storms[\s\d.]{0,40}?([\d.]+)\s+14\.4/.exec(text);
  if (m) {
    const v = sane(Number(m[1]));
    if (v != null) return { value: v, tier: "multicol", raw: m[1] };
  }

  // loose:允许中间出现文字注释。仍然锚定 14.4、仍然取紧邻它的那个数。
  const l = /Named Storms.{0,40}?([\d.]+)\s+14\.4/.exec(text);
  if (l) {
    const v = sane(Number(l[1]));
    if (v != null) return { value: v, tier: "loose", raw: l[1] };
  }

  return null;
}

async function headStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    return res.status;
  } catch {
    return null;
  }
}

/** HEAD 只取 Last-Modified —— 几百字节,可以 1-2 秒一轮而不打扰 CSU 的站点
 * (159KB 全页那样轮询 11 小时,更可能的结局是被 WAF 拉黑,整晚全废)。
 * 返回 null = 这一轮 HEAD 没拿到可信答案(超时/无该头),调用方必须退回 GET,
 * 绝不可当成"页面没变" —— 那会把网络抖动变成永久漏判。 */
async function headLastModified(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    if (!res.ok) return null;
    return res.headers.get("last-modified");
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<{ lastModified: string | null; text: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return { lastModified: res.headers.get("last-modified"), text: stripHtml(await res.text()) };
  } catch {
    return null;
  }
}

// ── 下单 ──

async function fireOnce(leg: Leg, value: number, tag: string): Promise<TradeAttempt | null> {
  const ask = await bestAskOf(leg.tokenId);
  if (ask == null) {
    emit({ kind: "skip", why: "空盘,taker 任何价位不可成交", leg: leg.short, tag });
    return null;
  }
  if (ask > MAX_PRICE) {
    // bot 已经把价推上去了 —— 剩下的边际不值得承担解析风险,放弃是正确答案。
    emit({ kind: "skip", why: `ask ${ask} > --max-price ${MAX_PRICE},不追高`, leg: leg.short, tag });
    return null;
  }
  const attempt = await executeSignal({
    qid: leg.qid,
    tokenId: leg.tokenId,
    conditionId: leg.conditionId,
    eventId: EVENT_ID,
    outcome: leg.outcome,
    question: leg.question,
    marketUrl: leg.marketUrl,
    label: `🎯 release-sniper CSU=${value} → ${leg.short}${tag ? ` ${tag}` : ""}`,
    stance: "release_sniper",
    llmStance: null,
    llmConfidence: null,
    llmEventStatus: "decided", // 数据已发布 = 事件已决,不是预告期
    // 锚取**下单前实时 ask**:这是主动决策买入,不是跟随信号,漂移带在此
    // 无意义;不追高由 --max-price 这道更硬的闸负责。
    bestAskAtSignal: ask,
    bookEmpty: false,
    declarative: true, // 官方数字直接决定结算,与"宣告类裁定"同语义
    dirMethod: "outcome-exact",
    negRisk: leg.negRisk,
    feesEnabled: leg.feesEnabled,
    feeRate: leg.feeRate,
    forecastTemplate: false,
    // 追高闸只封信号时刻的 ask;这道帽把 freshAsk 与 limitPrice 一并封在
    // --max-price + 滑点带之内(只收紧不放宽,EXEC_MAX_PRICE 更严时以它为准)。
    maxPriceCap: EXEC_PRICE_CAP,
    budgetMs: 120_000,
  });
  emit({
    kind: "trade",
    tag,
    leg: leg.short,
    ask,
    priceCap: EXEC_PRICE_CAP,
    status: attempt.status,
    reason: attempt.reason,
    filledUsd: attempt.filledUsd,
    avgPrice: attempt.avgPrice,
    orderId: attempt.orderId,
  });
  // 成交均价事后核对(2026-08-07):限价封的是**最坏**成交价,均价是限价以下
  // 扫到哪算哪的加权值(ledger #108:limit 0.97 / avg 0.961)。均价越过
  // --max-price 不代表下单错了 —— 代表这个参数的直觉含义与实际行为分了岔,
  // 必须在当场留下一行,而不是等下一次审计从 ledger 里考古出来。
  if (attempt.avgPrice != null && attempt.avgPrice > MAX_PRICE) {
    emit({
      kind: "avg-price-over-cap",
      leg: leg.short,
      tag,
      avgPrice: attempt.avgPrice,
      maxPrice: MAX_PRICE,
      limitPrice: attempt.limitPrice,
      note: "--max-price 是追高闸(封信号时刻 ask),不是成交均价上限",
    });
  }
  return attempt;
}

async function fireAndRefill(leg: Leg, value: number, pdfLiveAtFire: boolean): Promise<void> {
  // ① 的事后纠错 watcher(2026-08-07,与开火解耦):②∧③ 开火不再等 PDF,
  // 但"开火后 PDF 长时间不上线"正是 ① 原本要防的可疑形态(首页无关刷新),
  // 必须叫人 —— 首单已出(仅 --usd 量级,08-06 定调交给仓位),人工 touch
  // trading-halt 能拦住的是剩余补仓(fireOnce 每轮都走 executeSignal 的 halt 闸)。
  // 与补仓循环并发跑,不占用复访节奏;函数末尾统一 await,不让告警死在进程退出后。
  const pdfWatch = pdfLiveAtFire
    ? null
    : (async () => {
        const deadline = Date.now() + PDF_POST_FIRE_ALERT_MS;
        while (Date.now() < deadline) {
          if ((await headStatus(PDF_URL)) === 200) {
            emit({ kind: "pdf-live", url: PDF_URL, postFire: true });
            return;
          }
          await sleep(5_000);
        }
        emit({ kind: "pdf-missing-post-fire", waitedMs: PDF_POST_FIRE_ALERT_MS });
        await notify(
          "⚠️ 已按 ②∧③ 开火,但 PDF 迟迟未上线 —— 请人工核对",
          `<p>开火 ${Math.round(PDF_POST_FIRE_ALERT_MS / 60_000)} 分钟后 <a href="${PDF_URL}">${PDF_URL}</a> 仍非 200(正常时差:首页领先 PDF ~37s,08-05 实测)。</p>` +
            `<p>若怀疑首页是无关刷新、读到的是旧数字,立刻 <code>touch ~/prededge/data/trading-halt</code> —— 首单拦不住,剩余补仓会被拦住。</p>`
        );
      })();
  const first = await fireOnce(leg, value, "");
  await notify(
    `${first?.status === "filled" || first?.status === "partial" ? "✅" : "⚠"} CSU=${value} → ${leg.short} 首单 ${first?.status ?? "未发起"}`,
    `<p>数字 <b>${value}</b> → 命中 <b>${leg.short}</b></p>` +
      `<p>市场:${leg.question}</p>` +
      `<p>结果:<b>${first?.status ?? "未发起"}</b> ${first?.reason ?? ""}</p>` +
      `<p>成交:$${first?.filledUsd ?? 0} @ ${first?.avgPrice ?? "—"}</p>` +
      `<p>模式:${ARMED ? "实弹" : "DRY(未开 --arm)"} · 单笔上限 $${USD} · 追高闸 ${MAX_PRICE}(最坏成交价 ${EXEC_PRICE_CAP.toFixed(3)})</p>`
  );

  // 补仓复访:卖家/bot 补货不会再触发任何信号,只能自己回头看。每轮都完整
  // 再过一遍 executeSignal 全部风控,补仓量由 perTokenMaxUsd − 已有敞口封死。
  let filledTotal = first?.filledUsd ?? 0;
  for (let i = 1; i <= REFILL_TRIES; i += 1) {
    await sleep(REFILL_EVERY_MS);
    const a = await fireOnce(leg, value, `♻补仓#${i}`);
    if (a?.status === "filled" || a?.status === "partial") filledTotal += a.filledUsd ?? 0;
  }
  emit({ kind: "refill-done", leg: leg.short, filledTotal });
  await notify(
    `📊 CSU=${value} → ${leg.short} 补仓收尾,累计成交 $${Math.round(filledTotal * 100) / 100}`,
    `<p>首单 + ${REFILL_TRIES} 次补仓复访结束。</p><p>累计成交:<b>$${Math.round(filledTotal * 100) / 100}</b></p>` +
      `<p>明细见 ${OUT}</p>`
  );
  if (pdfWatch) await pdfWatch;
}

// ── 主循环 ──

async function main(): Promise<void> {
  const startedAt = Date.now();
  emit({
    kind: "start",
    eventId: EVENT_ID,
    usd: USD,
    maxPrice: MAX_PRICE,
    execPriceCap: EXEC_PRICE_CAP,
    armed: ARMED,
    envExecMode: executionMode(),
    simulate: SIMULATE,
    refillTries: REFILL_TRIES,
    out: OUT,
  });

  // --arm 未给 → 强制 dry。即使 .env 里 EXEC_MODE=live 也不下单:一个没
  // 显式武装的进程绝不允许因为环境变量就开始花钱。
  if (!ARMED) {
    process.env.EXEC_MODE = "dry";
    emit({ kind: "safety", msg: "未给 --arm,已强制 EXEC_MODE=dry(不会真下单)" });
  }
  // 单笔额度按参数收紧(executeSignal 读 env)。只收紧不放宽:取两者较小值,
  // 防止命令行参数意外把生产上限调大。per-token 与 per-event 一起钉到 USD*4
  // (补仓容量;缺 per-event 时默认 2×单笔会先咬住,声明的 4× 永远达不到),
  // 判据与逐条理由见 execCapPins。
  const pins = execCapPins(USD, process.env);
  process.env.EXEC_MAX_ORDER_USD = pins.maxOrder;
  process.env.EXEC_PER_TOKEN_MAX_USD = pins.perToken;
  process.env.EXEC_PER_EVENT_MAX_USD = pins.perEvent;

  const legs = await buildLegs();
  if (!legs) {
    await notify("🛑 release-sniper 拒绝启动", "<p>档位文本比对失败或字段缺失,详见日志。未下任何单。</p>");
    process.exit(1);
  }
  emit({
    kind: "legs",
    legs: [...legs.values()].map((l) => ({ short: l.short, q: l.question, token: l.tokenId.slice(0, 12) })),
  });

  // 自检路径:跳过等待,直接按给定数字走完映射 + 下单 + 补仓。
  if (SIMULATE != null && Number.isFinite(SIMULATE)) {
    const b = bracketFor(SIMULATE);
    emit({ kind: "simulate", value: SIMULATE, bracket: b?.short ?? null });
    if (!b) {
      emit({ kind: "fatal", msg: `simulate ${SIMULATE} 映射不出唯一档位` });
      process.exit(1);
    }
    // 自检路径不启动 ① watcher(pdfLiveAtFire=true):--simulate 本就跳过等待,
    // 事后纠错告警在自检里只是噪音。
    await fireAndRefill(legs.get(b.short)!, SIMULATE, true);
    return;
  }

  const baseHtml = await fetchHtml(HTML_URL);
  const baselineLastModified = baseHtml?.lastModified ?? null;
  const baselineValue = baseHtml ? parseNamedStorms(baseHtml.text) : null;

  // HEAD 快路的可信性验证:HEAD 报的 Last-Modified 必须和刚才 GET 到的那份
  // 一致,否则这条快路要么永远不触发、要么一上来就误触发。任一异常都退回
  // 每轮 GET —— 慢一点是可接受的代价,判错不是。
  const headProbe = HEAD_FAST ? await headLastModified(HTML_URL) : null;
  const headFast = HEAD_FAST && headProbe != null && baselineLastModified != null && headProbe === baselineLastModified;

  // baseline 的 Last-Modified 缺失是个静默的大洞:freshPage 的表达式里
  // `baselineLastModified == null` 会让 ② 恒真,②∧③ 当场退化成只剩 ③,而
  // 日志上完全看不出来。今晚实测拿得到,但拿不到时必须当场说破。
  if (baselineLastModified == null) {
    emit({ kind: "warn", msg: "基线 Last-Modified 缺失 —— ② 页面新鲜度闸恒真,已退化为两重确认" });
  }

  emit({
    kind: "baseline",
    lastModified: baselineLastModified,
    value: baselineValue,
    headFast,
    headProbe,
    llmFallback: LLM_FALLBACK,
  });
  await notify(
    "🔫 release-sniper 已上岗",
    `<p>模式:<b>${ARMED ? "实弹" : "DRY"}</b> · 单笔 $${USD} · 追高闸 ${MAX_PRICE}(最坏成交价 ${EXEC_PRICE_CAP.toFixed(3)})</p>` +
      `<p>基线:Last-Modified=${baselineLastModified} · 当前数字=${baselineValue}</p>` +
      `<p>开火判据:②首页已刷新 ∧ ③数字双读稳定 即下单;①PDF 200 为事后纠错信号(超 ${Math.round(PDF_POST_FIRE_ALERT_MS / 60_000)}min 不上线即告警)。</p>` +
      `<p>轮询:${headFast ? `HEAD 快路(${POLL_COLD_MS / 1000}s / 热 ${POLL_HOT_MS / 1000}s)` : "每轮 GET 全页(HEAD 不可信,已退回)"}` +
      ` · 正则失败降级 LLM:${LLM_FALLBACK ? "开" : "关"}</p>`
  );

  let pdfLive = false;
  let pendingValue: number | null = null;
  let pendingSince = 0;
  let done = false;
  // LLM 降级路径的状态:上次调用时刻(限流)、上次读到的值(双读)、
  // 以及"解析全线失败"的人工告警是否已发过(只发一次,不刷屏)。
  let lastLlmAt = 0;
  let parseFailAlerted = false;
  /** LLM 这一路的结局,拼进人工告警邮件 —— 让人一眼看出是"没读出来"还是
   * "读出来了但两路不一致(已拒绝下单)",两者要采取的行动不同。 */
  let llmNote = LLM_FALLBACK ? "" : "(LLM 已禁用)";

  while (!done && Date.now() - startedAt < MAX_RUN_MS) {
    // ① PDF
    if (!pdfLive) {
      const st = await headStatus(PDF_URL);
      if (st === 200) {
        pdfLive = true;
        emit({ kind: "pdf-live", url: PDF_URL });
        await notify("🔔 CSU 报告已上线", `<p><a href="${PDF_URL}">${PDF_URL}</a></p><p>正在等首页刷新以读取数字…</p>`);
      }
    }

    // ② 页面新鲜度。HEAD 快路可信时,发布前只花几百字节问一句"变了没";
    //    PDF 一上线就切回每轮 GET —— 那之后窗口只剩几分钟,要的是速度和
    //    stale-page 的留痕,省流量已经没意义了。
    let needGet = true;
    if (headFast && !pdfLive) {
      const lm = await headLastModified(HTML_URL);
      // lm == null(HEAD 抖了/没这个头)一律退回 GET,不当作"没变"。
      if (lm != null) needGet = lm !== baselineLastModified;
    }

    let sawSignal = pdfLive;
    if (needGet) {
      const cur = await fetchHtml(HTML_URL);
      if (cur) {
        const freshPage = baselineLastModified == null || cur.lastModified !== baselineLastModified;
        if (freshPage) sawSignal = true;
        // 正则梯队:exact 读不出就换排版试,全部失败才轮到 LLM。
        const reading = parseNamedStormsTiered(cur.text);
        const val = reading?.value ?? null;
        if (val != null && freshPage) {
          // ③ 数字双读
          if (pendingValue === val) {
            const stableMs = Date.now() - pendingSince;
            // 2s(2026-08-05 从 5s 降):5 是当初随手取的常数,没有实测依据,
            // 而它是端到端延迟里最大的单项。1s 轮询下 2s = 连读 3 次,采样
            // 冗余仍在;且梯队每层都锚定 14.4,要读出"格式正确但数值错误"
            // 的结果,页面得恰好凑出 `Named Storms <错数> 14.4` —— 半成品
            // 页面几乎不可能,更可能的结果是不匹配(null,不下单)。
            const gate = fireGate({ stableMs, stableThresholdMs: STABLE_MS, pdfLive });
            if (gate.fire) {
              const b = bracketFor(val);
              emit({
                kind: "confirmed",
                value: val,
                tier: reading!.tier,
                raw: reading!.raw,
                stableMs,
                pdfLive,
                bracket: b?.short ?? null,
                lastModified: cur.lastModified,
              });
              if (!b) {
                await notify("🛑 数字映射不出唯一档位", `<p>解析值 ${val},BRACKETS 表命中数 ≠ 1。未下单,请人工处理。</p>`);
                done = true;
                break;
              }
              // 非 exact 层命中 = 排版确实变了,读数虽经同样的锚校验,仍要让人
              // 看一眼。邮件先发再下单(fail-open,发不出去不阻塞交易路径)。
              if (reading!.tier !== "exact") {
                await notify(
                  `⚠️ 降级正则(${reading!.tier})读到 ${val} → ${b.short},即将下单`,
                  `<p>主正则未匹配,由 <b>${reading!.tier}</b> 层命中。原文形态:<code>${reading!.raw}</code></p>` +
                    `<p>判定档:<b>${b.short}</b> · 双读已一致(${stableMs}ms)</p>` +
                    `<p>若这一读是错的,立刻 <code>touch ~/prededge/data/trading-halt</code> —— 首单拦不住(仅 $${USD}),补仓会被拦住。</p>`
                );
              }
              await fireAndRefill(legs.get(b.short)!, val, pdfLive);
              done = true;
              break;
            }
          } else {
            pendingValue = val;
            pendingSince = Date.now();
            emit({ kind: "pending", value: val, tier: reading!.tier, raw: reading!.raw, lastModified: cur.lastModified, pdfLive });
          }
        } else if (val != null && !freshPage && pdfLive) {
          // PDF 发了但首页还挂着旧内容 —— 这正是最危险的窗口,绝不下单。
          emit({ kind: "stale-page", value: val, lastModified: cur.lastModified });
        } else if (val == null && freshPage) {
          // 页面刷新了,但**四层正则全部读不出来** —— 排版变得超出预案。
          // 这一支原本是完全静默的:既不落行也不发信,人要等 11 小时后那封
          // 超时邮件才知道错过了整个窗口。两条兜底按顺序上。
          // (2026-08-07:与开火判据同批去掉 pdfLive 前置 —— ② 已真、数字
          //  读不出时,LLM 降级读数没有理由等 PDF;LLM_GAP_MS 限流不变,
          //  读出后照走 fireGate 同一套 ②∧③ 语义与全部下单风控。)
          emit({ kind: "parse-miss", tiersTried: 4, lastModified: cur.lastModified, sample: cur.text.slice(0, 300) });

          if (LLM_FALLBACK && Date.now() - lastLlmAt >= LLM_GAP_MS) {
            lastLlmAt = Date.now();
            const llmInput = {
              pageText: cur.text,
              label: "Named Storms",
              context:
                "This is the Colorado State University (CSU) Atlantic hurricane season forecast page. " +
                "Extract the FULL-SEASON 2026 forecast total for named storms from the headline/summary " +
                "forecast table — the same table whose adjacent column shows the 1991-2020 climatological " +
                "average of 14.4. That full-season total already includes storms observed so far this year; " +
                "do NOT report the count observed to date, do NOT report a 'remaining season' figure, and do " +
                "NOT add them together yourself. Do not report hurricanes, major hurricanes, or ACE.",
              min: 0,
              max: 30,
            };
            // 双读改**并发**(2026-08-05):原来是"读一次 → 等 60s → 再读一次",
            // 那 60s 全花在等上。而双读要的是"两次独立推理互为对照",**不是
            // 时间间隔** —— 两个并发调用同样是两次独立采样。耗时因此从
            // 60s+ 压到 ≈ 单次(实测单次 5-9s,并发 3 路几乎无差),交叉验证
            // 一分没丢。这是唯一能挡住"LLM 读错行"的机制:引文校验只能证明
            // 它引的那段真在页面里、报的数真在引文里,证明不了它读的是
            // Named Storms 那一行而不是隔壁 Hurricanes。
            const [r1, r2] = await Promise.all([
              extractNumberWithLlm(llmInput),
              extractNumberWithLlm(llmInput),
            ]);
            const agree = r1 != null && r2 != null && r1.value === r2.value;
            emit({
              kind: "llm-read",
              agree,
              a: r1 && { value: r1.value, raw: r1.raw, kind: r1.kind, quote: r1.quote.slice(0, 160) },
              b: r2 && { value: r2.value, raw: r2.raw, kind: r2.kind, quote: r2.quote.slice(0, 160) },
            });

            if (agree) {
              const b = bracketFor(r1!.value);
              emit({ kind: "llm-confirmed", value: r1!.value, bracket: b?.short ?? null });
              if (!b) {
                await notify(
                  "🛑 LLM 读数映射不出唯一档位",
                  `<p>读到 ${r1!.value}(原文 ${r1!.raw}),BRACKETS 命中数 ≠ 1。未下单,请人工处理。</p>`
                );
                done = true;
                break;
              }
              await notify(
                `🤖 LLM 降级路径确认 ${r1!.value} → ${b.short},即将下单`,
                `<p>四层正则全未匹配(排版超出预案),转 Opus。<b>两个并发独立调用读数一致</b>。</p>` +
                  `<p>原文形态:<code>${r1!.raw}</code> · 判定档:<b>${b.short}</b></p>` +
                  `<p>引文 A:<code>${r1!.quote.slice(0, 160)}</code></p>` +
                  `<p>引文 B:<code>${r2!.quote.slice(0, 160)}</code></p>` +
                  `<p>理由:${r1!.reasoning}</p>` +
                  `<p>若这一读是错的,立刻 <code>touch ~/prededge/data/trading-halt</code> —— 首单拦不住(仅 $${USD}),补仓会被拦住。</p>`
              );
              await fireAndRefill(legs.get(b.short)!, r1!.value, pdfLive);
              done = true;
              break;
            }

            // 不一致 / 有一路读不出 —— 绝不取其一下单。记下缘由,交给下面
            // 那封人工告警(每轮 ≥LLM_GAP_MS 会再试一次并发双读)。
            llmNote =
              r1 == null && r2 == null
                ? "(转 Opus 后两路都没读出来)"
                : `(转 Opus 后两路读数不一致:${r1?.value ?? "读不出"} vs ${r2?.value ?? "读不出"} —— 已拒绝下单)`;
          }

          // 四层正则 + 并发双读都没能给出可下单的结果 → 立刻叫人,别等超时邮件。
          if (!parseFailAlerted) {
            parseFailAlerted = true;
            await notify(
              "⚠️ 报告已发但数字读不出来 —— 请人工介入",
              `<p>首页已刷新${pdfLive ? "(PDF 已 200)" : "(PDF 尚未上线)"},但四层正则读不出 Named Storms ${llmNote}。</p>` +
                `<p>页面:<a href="${HTML_URL}">${HTML_URL}</a></p>` +
                `<p>人工读数后可用自检路径直接下单:</p>` +
                `<pre>ssh sufe 'cd ~/prededge &amp;&amp; ./run-cron.sh scripts/release-sniper.ts --event ${EVENT_ID} --usd ${USD} --max-price ${MAX_PRICE} --arm --simulate &lt;数字&gt;'</pre>` +
                `<p>进程仍在跑,若页面稍后变成可解析的排版,它会自己接管。</p>`
            );
          }
        }
      }
    }

    await sleep(sawSignal ? POLL_HOT_MS : POLL_COLD_MS);
  }

  if (!done) {
    emit({ kind: "timeout", ranMs: Date.now() - startedAt });
    await notify("⏱ release-sniper 到时退出", "<p>未等到 ②∧③ 同时满足,未下任何单。</p>");
  }
  emit({ kind: "end", ranMs: Date.now() - startedAt });
}

// 直接执行时才跑 main;被测试 import 时只拿 bracketFor。
if (require.main === module) {
  main().catch((err) => {
    emit({ kind: "fatal", msg: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
