/**
 * 已触发条款守盘狙击器 —— Oregon D4 干旱盘(2026-08-08 建;死线 08-13 finalize)。
 *
 * ── 它和 release-sniper 不是一类东西 ──────────────────────────
 * release-sniper 蹲的是"未知数字即将发布"→ 解析 → 映射档位 → 抢在 bot 前面
 * 成交,本质是**竞速器**,全部工程量花在把确认时点从 +13s 压到 +6.5s。
 *
 * 这条盘反过来:答案两天前就出来了。USDM 2026-08-04 那期(08-06 发布)
 * Oregon D4 = 2.15%,条款阈值 1.00%,而条款是**棘轮式**("any weekly release"
 * 达标即锁 YES,后续回落无效)。所以没有任何要抢的东西 —— 要做的只有两件:
 *   1. 把盘上 ≤ 阈值价的卖单**吃干净**(书是活的,05:47→05:50 三分钟内最优档
 *      0.72→0.70→0.68,卖方在持续下调;单笔吃完还会有人补货);
 *   2. 守住唯一的实质风险 R1 —— NDMC 在 7 天更正窗内把那期数据撤回/下修。
 * 于是它是**守盘器**:长跑、每轮重拉 book、每轮重核 USDM,而不是竞速器。
 *
 * ── 唯一能亏钱的路径,以及针对它的闸 ──────────────────────────
 * 市场风险为零(条款已满足、两口径一致、D3 同向恶化佐证)。真正的 −100%
 * 只有一条:**NDMC 在 08-13 finalize 前把 08-04 那期 Oregon D4 更正到 <1.00%**。
 * 条款原文:"A correction will be considered only if issued before the market
 * finalizes settlement" —— 08-13 之后的更正一律无效。
 * 所以 R1 不能是"每天人工重拉一次命令",必须是**每轮下单前的硬闸**:
 *   · d4 ≥ 1.00 且两口径(statisticsType 1/2)一致  → 放行
 *   · 明确读到 d4 < 1.00                          → 落 kill-switch + 告警 + 退出
 *   · 读不到(超时/空数组/mapDate 不匹配)          → **停火但不 halt**(见下)
 *
 * "读不到"为什么必须与"被撤回"分开口径(这是本脚本最容易写错的一处):
 * USDM API 传错 aoi 会返回 `[]` 且 **HTTP 200** —— 静默失败,与"该州无数据"
 * 完全无法区分(08-08 实测踩过,当时是拿 2025 历史区间做诊断分离才认出是
 * 参数错)。把 `[]` 当成"d4 不达标"去落 kill-switch,等于让一次网络抖动
 * 永久停掉整个系统的交易;反过来把它当成"仍达标"照常下单,等于 R1 闸形同
 * 虚设。正确答案是第三态:停火、继续重试、超过 --usdm-stale 分钟发人工告警。
 *
 * ── 为什么默认 --max-price 0.95(不是 0.90,更不是 0.99)─────────────
 * 08-08 06:35Z 实测 ask 侧:
 *   0.72×160 0.76×21 0.77×100 0.79×50 0.83×55 0.88×5 0.89×5 0.90×21
 *   | 0.97×11 0.98×62 0.99×15
 * 0.90 到 0.97 之间**一张挂单都没有**,所以 0.90/0.93/0.95 三个阈值在当前
 * book 下结果完全相同:417 股 / $321.24 / 净 $93.19 / 回报 29.0%。
 * 真正的决策只有一个 —— 要不要吃 0.98 那 62 股:
 *   增本金 $60.76 → 增净利 $1.18,边际回报 1.94%,赔率 51:1。
 * 单档 EV 门槛(含费,q = R1 概率):p 这一档要求 q < (1−p) − rate·p·(1−p)
 *   p=0.90 → q<9.55%   p=0.95 → q<4.76%   p=0.97 → q<2.85%
 *   p=0.98 → q<1.90%   p=0.99 → q<0.95%
 * 我方对 R1 的估计落在 1–3%,恰好横跨 0.98 那一档的门槛 ⟹ 那 62 股期望值
 * 约等于零而波动是全损 $60,不碰;0.99 明确负 EV;0.97 只有 11 股($10 换
 * $0.30)与 0.99 只有 15 股($15 换 $0.14),金额小到与决策无关。
 *
 * 于是刀口在 0.95,理由是**它比 0.90 更好而不是更激进**:
 *   ① 容错口径更贴合:0.95 要求 q<4.76%(对 1–3% 的估计留 1.6–4.8 倍余量);
 *     0.90 要求 q<9.55% 是过度保守 —— 为防一个 2% 的风险去放弃边际回报
 *     5–11% 的档位。
 *   ② 守盘器要跑到 08-13,book 是活的(08-08 一个上午动了三次:0.68→0.66→
 *     0.72,且 0.66/0.67 那 160 股是被卖方**上调**成 0.72,不是被吃掉)。
 *     若明天挂出 0.92×200,0.90 那道闸会白白放过一档 8.7% 边际回报的肉。
 *     0.95 既接得住未来的 0.91–0.95,又天然排除现存的 0.97/0.98/0.99。
 * 要吃尾档仍须显式 `--max-price 0.99`,不给默认。
 *
 * 保本准确率对照(= ask + rate×ask×(1−ask),rate=0.05):
 *   0.72 → 0.7301   0.83 → 0.8371   0.90 → 0.9045   0.95 → 0.9524
 *   (0.83 那格初版误写 0.8359,2026-08-08 由 tests/usdmScan.test.ts 的
 *    对照断言抓出并订正;不改变任何已做决策 —— 置信度 97–99% 远高于两者。)
 * 我方置信度 = "条款已满足 ∧ 仅剩 R1" ≈ 97–99%,高于 0.9524 但不足以支撑
 * 0.9810。这就是那一刀的位置。
 *
 * ── 额度:为什么不动全局 env,以及 --budget 咬在哪 ───────────────
 * 生产 .env:单笔 $100 / 日 $300 / 总 $800,perToken 未设(默认 = 单笔 $100)。
 * perToken 那条会在**第一笔 $100 成交后立刻把这个 token 永久封死**,所以必须
 * 在本进程内钉高(与 release-sniper.execCapPins 同一手法,只影响本进程)。
 * 日额度 $300 则是天然的第二道闸:$300 恰好吃到 0.83 档(386 股/$293.22/
 * 净 $90.04),也就是 ≤0.95 全书净利 $93.19 的 **96.6%**;剩下 0.88/0.89/0.90
 * 那 31 股只值 $3.15,留到第二天再吃完全不亏。--budget 超过日额度时本进程会把
 * EXEC_DAILY_MAX_USD 一并钉高(只影响本进程),代价是同日 chain-watch 的额度被
 * 挤占同样的数额 —— 这一行会在日志和邮件里显式说破,不静默发生。
 *
 * ── 风控 ───────────────────────────────────────────────────────
 * 下单一律走 lib/polymarket/tradeExecutor.executeSignal:kill-switch、连亏
 * 熔断、价格带、漂移带/暴跌守卫、per-token/同事件敞口帽、日/总额度、下单前
 * 余额核查、write-ahead intent 全部原样生效。本脚本**额外**三道更严的闸:
 *   · --arm 不给就强制 dry(即使 .env 里 EXEC_MODE=live)
 *   · --max-price 追高闸 + maxPriceCap(= --max-price + 1 档,只收紧不放宽)
 *   · 启动身份三校验:conditionId / questionID / YES tokenId 逐字比对写死常量,
 *     且 outcomes[0] 必须是 "Yes"、条款关键句必须还在 —— 任一不符拒绝启动。
 *     (方向写反 = −100%,这是 bucket 映射之外的另一处"硬错误集中地"。)
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *   # 干跑(默认。先用它确认身份校验 + USDM 闸 + 盘口读数)
 *   ./run-cron.sh scripts/oregon-sniper.ts
 *
 *   # 只体检不循环:跑一轮全部闸门就退出
 *   ./run-cron.sh scripts/oregon-sniper.ts --once
 *
 *   # 常驻监控 + 追单(推荐的长期形态,crontab 每 10 分钟一轮)。
 *   # 分钟字段刻意写成枚举而不是斜杠步进:那个写法里的星号斜杠会**提前关闭
 *   # 本块注释**,tsc 当场报 TS1109。两种写法在 cron 里完全等价。
 *   0,10,20,30,40,50 * * * * flock -n /tmp/prededge-oregon.lock \
 *     $HOME/prededge/run-cron.sh scripts/oregon-sniper.ts --once --arm \
 *     --budget 330 >> $HOME/prededge/logs/oregon-sniper.log 2>&1
 *
 *   # 实弹(必须显式 --arm)
 *   ./run-cron.sh scripts/oregon-sniper.ts --arm
 *
 *   # 实弹 + 吃满 ≤0.99 全书(不推荐:0.98 那 62 股 $60.76 只换 $1.18,见上)
 *   ./run-cron.sh scripts/oregon-sniper.ts --arm --max-price 0.99 --budget 420
 *
 *   # 分层额度(2026-08-08 用户裁决:闸门按机会质量分级,不一刀切)。
 *   # 低价档给大容量、贵档维持原额度;实际仍被总敞口余量硬封。
 *   ./run-cron.sh scripts/oregon-sniper.ts --arm --tier 0.80:800 --tier 0.85:500 --budget 330
 *
 *   # R1 停机路径自检(⚠ 必须把 halt 文件指到临时路径,否则停掉整个生产系统)
 *   EXEC_HALT_FILE=/tmp/halt-selftest ./run-cron.sh scripts/oregon-sniper.ts \
 *     --simulate-revoked --once --no-mail
 *
 * 参数:
 *   --arm                 实弹开关。不给 = 全程 dry,只演不买
 *   --once                跑一轮就退出(体检 / cron 模式;仍受 --arm 约束)。
 *                         cron 模式下两处行为差异:不发上线邮件(否则 144 封/天)、
 *                         日志追加到固定的 oregon-sniper-cron.jsonl
 *   --simulate-revoked    自检:强制走 R1 停机路径。会写真实 haltFile,见上
 *   --max-price <价>      追高闸,默认 0.95。最坏成交价 = 此价 + 1 档 = 0.96
 *                         (刻意不用 +EXEC_SLIPPAGE,理由见 priceCapFor)
 *   --budget <金额>       本 token 总预算(fallback 档),默认 330。钉
 *                         perToken/perEvent,必要时连带钉 daily。单笔仍受
 *                         EXEC_MAX_ORDER_USD 约束
 *   --tier <价>:<预算>    按价分层的预算,可重复给。ask ≤ 价 时用该预算,取
 *                         最先命中的低价档;都不命中则用 --budget。
 *                         例:--tier 0.80:800 --tier 0.85:500
 *                         命中某档时,**单笔上限 EXEC_MAX_ORDER_USD 一并抬到
 *                         当档预算**(2026-08-08 A 方案):低价档把 per-token
 *                         抬到 $800 后,真正的限速器就是单笔 $100 —— cron 每
 *                         10 分钟一轮,吃满 $378 要 4 轮 40 分钟,而 ask≤0.80
 *                         这种低价抛单更容易被别人抢走。fallback 档不抬,维持
 *                         生产 .env 的常规行为。
 *                         ⚠ 只放宽 perToken/perEvent/daily/maxOrder 这四个
 *                         "单机会规模"闸。EXEC_TOTAL_MAX_USD(未结算总敞口)
 *                         **无任何放宽入口** —— 那道闸保护的是"所有判断同时
 *                         错"的账户级情形,分层对它无话可说,故它始终是实际硬顶。
 *   --poll <秒>           盘口轮询间隔,默认 20
 *   --usdm-ttl <分>       USDM 读数复用时长,默认 15(这么久内不重拉)
 *   --usdm-stale <分>     USDM 连续读不到多久发人工告警并持续停火,默认 60
 *   --alert-after <轮>    外部源"读不到"连续多少轮才发告警邮件,默认 3
 *                         (cron 10 分钟一轮 ⟹ 约 30 分钟)。实测单轮失败率
 *                         1-2% 且下一轮即自愈,单轮就发 = 噪音淹掉真事件。
 *                         **只对"读不到"这类会自愈的状态生效**;身份/条款不符、
 *                         触发被撤回这些不会自愈的,永远第一轮就发
 *   --max-hours <小时>    总运行上限,默认 11(run-cron 给 12h 兜底)
 *   --no-mail             不发邮件
 */
import fs from "node:fs";
import path from "node:path";
import { CLOB_API, GAMMA_API } from "../lib/polymarket/config";
import { executeSignal, executionMode, execConfig } from "../lib/polymarket/tradeExecutor";
import type { TradeAttempt } from "../lib/polymarket/tradeExecutor";

// ── 标的常量(全部 2026-08-08 实测取得,启动时逐字比对 Gamma 返回)──────
// 写死而不是"按 slug 查到什么就买什么":slug 查询返回的是平台可变数据,
// 而买错腿是 −100%。这三个值 + outcomes 顺序构成方向的唯一事实源。

const SLUG = "will-oregon-reach-d4-exceptional-drought-by-august-31-2026-20260721193813646";
const EVENT_ID = "744056";
const CONDITION_ID = "0xd0e66191853681730e4a0cfbf71b1ee9c73d8c222e2cb139bdd8147886b38075";
const QUESTION_ID = "0x07c68043825c3f4331acf8f7b6971abb7064aa8345b32a93260a7fb8270fed37";
/** 买的就是这一条腿。条款已满足 ⟹ YES 必然结算 $1。 */
const YES_TOKEN_ID = "44935700105237965955717992503068972172128092356886921170252269229765298541502";

/** 条款关键句。平台改 description = 我们的全部推理失去依据,立刻停机。
 * 取的是**判据本身**的三个不可替换要素(阈值/口径/棘轮语义),不是整段原文
 * —— 整段比对会被一个标点改动误停,只比对这三句才既敏感又不脆。 */
const CLAUSE_MUST_CONTAIN = [
  "1.00% or greater",
  '"Categorical Percent Area"',
  "in any weekly release published from market creation through August 31, 2026",
];

// ── USDM 数据源 ────────────────────────────────────────────────
/** Oregon 的 **FIPS 数字码**。传 "OR" 会返回 `[]` + HTTP 200(静默失败),
 * 与"无数据"不可区分 —— 这个坑 08-08 实测踩过,常量写在这里配注释是唯一
 * 防它复发的办法。 */
const OREGON_FIPS = 41;
/** 触发期的 mapDate。窗口钉死在这一期:后续期次 D4 回落与本盘无关(棘轮
 * 条款已锁),而"拉最近一期"会在下周四新数据出来时把闸门指向错误的对象。 */
const TRIGGER_MAP_DATE = "8/4/2026";
const TRIGGER_MAP_DATE_ISO = "2026-08-04";
const D4_THRESHOLD = 1.0;
const USDM_API = "https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent";

// ── 参数 ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (n: string): string | null => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? null) : null);
const num = (n: string, d: number): number => {
  const v = arg(n);
  if (v == null) return d;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
};

const ARMED = argv.includes("--arm");
const ONCE = argv.includes("--once");
/** 自检:强制把 USDM 判成 revoked,走一遍 R1 停机路径(写 kill-switch + 告警)。
 * 为什么需要它:R1 是本脚本存在的一半理由,而它在生产上**永远不会自然触发**
 * (数据是好的)—— 于是"撤回时系统真的会停"这件事在实弹前是纯纸面推断。
 * fireDecision 的优先级已被离线测试钉住,但写文件那一段没有测试接缝。
 * ⚠ 它会写**真实的** haltFile,跑之前必须用 EXEC_HALT_FILE 指到临时路径:
 *   EXEC_HALT_FILE=/tmp/halt-selftest ./run-cron.sh scripts/oregon-sniper.ts \
 *     --simulate-revoked --once --no-mail
 * 不给 EXEC_HALT_FILE 就会停掉整个生产系统 —— 这是刻意不做防呆的:验证的
 * 正是这条真实路径,加个"自检时改写别处"的分支等于验证了另一段代码。 */
const SIMULATE_REVOKED = argv.includes("--simulate-revoked");
const MAX_PRICE = num("--max-price", 0.95);
/** 默认 330 = 当前 ≤0.95 全书 $321.24 + 约 $9 余量给 book 变动。日额度 $300
 * 会先咬住(吃到 0.83 档 ≈ $293 / 净 $90),差额 $3 由本进程抬日额度补上。 */
const BUDGET = num("--budget", 330);
/** `--tier <价>:<预算>`,可重复。收集所有出现处(argv 里紧跟每个 --tier 的那一项)。 */
const TIER_ARGS = argv.reduce<string[]>((acc, a, i) => (a === "--tier" && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const POLL_MS = num("--poll", 20) * 1000;
const USDM_TTL_MS = num("--usdm-ttl", 15) * 60_000;
const USDM_STALE_MS = num("--usdm-stale", 60) * 60_000;
/** "读不到"连败多少轮才升级为告警邮件。见 transientDecision 的注释。 */
const ALERT_AFTER = num("--alert-after", 3);
const MAX_RUN_MS = num("--max-hours", 11) * 3600_000;
const MAIL = !argv.includes("--no-mail");

/** CLOB 最小报价档(本市场 orderPriceMinTickSize = 0.01)。 */
const TICK = 0.01;

/**
 * 传给 executeSignal 的价格帽 —— **不是** MAX_PRICE + EXEC_SLIPPAGE(滑点带)。
 *
 * 这里刻意与 release-sniper 分道:那边取 --max-price + 滑点带,理由是"钉
 * MAX_PRICE 本身会把滑点带压成 0,FAK 只能吃簿顶一档,等于砍掉成交量"——
 * 那个理由在竞速场景下成立(澄清落地后的肉只有 20-60s,少吃一档就永远没了)。
 * 本盘**不是竞速**:窗口 5 天、每 20s 一轮,这一轮没吃到的档下一轮还在。
 * 于是那个宽度换不来任何东西,只带来一个真实的洞:
 *   --max-price 0.95 放行 ask=0.95 → limitPriceFor 把限价扩到 0.95+0.03=0.98
 *   → FAK 扫穿 0.96/0.97/0.98 —— 正是边际测算里判为"期望值约零、波动全损"
 *   的那 62 股。追高闸看着是 0.95,实际成交可以到 0.98。
 * 所以帽钉在 **MAX_PRICE + 一个 tick**:低价位(ask ≤ 0.93)时 limitPriceFor
 * 算出的 freshAsk + band 远低于帽,滑点带完整保留、行为一字不变;只有 ask
 * 进到 (0.93, 0.95] 这个窄区间时它才咬住,而那正是需要它咬的地方。
 * "最坏成交价 = 追高闸 + 1 档"这句话说得出口,也算得准。
 */
export const priceCapFor = (maxPrice: number, tick = TICK): number =>
  Math.min(0.999, Math.round((maxPrice + tick) * 100) / 100);

const EXEC_PRICE_CAP = priceCapFor(MAX_PRICE);

const ROOT = path.resolve(__dirname, "..");
/** --once(cron 模式)复用一个固定文件名追加,长跑模式一进程一文件。
 * 每轮一个带时间戳的文件在 cron 下是 144 个/天 × 5 天 = 720 个小文件,
 * 事后翻日志要按文件名排序拼时间线,而这条盘的复盘恰恰是按时间线读的。 */
const OUT = ONCE
  ? path.join(ROOT, "data", "oregon-sniper-cron.jsonl")
  : path.join(ROOT, "data", `oregon-sniper-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`);

/** 目录在首次落行时才建 —— 顶层建目录会让测试仅仅 import 纯函数就产生
 * 文件系统副作用(release-sniper 那边同款处理)。 */
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

/**
 * 终态类邮件的去重发信 —— cron 模式(--once 每 10 分钟一轮)的必需件。
 *
 * "市场已 finalize""触发被撤回""条款被改写"这类终态会**持续成立**:不去重就是
 * 每 10 分钟一封同样的告警,一天 144 封,而真正的新事件会被埋在里面。被噪音
 * 淹掉的告警等于没有告警。
 *
 * 长跑模式(非 ONCE)刻意不去重:一个进程生命周期内每种终态最多发生一次,而跨
 * 进程持久化去重会让"重启后市场仍关着"这件事静默掉 —— 那正是重启的人需要
 * 知道的第一件事。
 *
 * sentinel 落在 data/oregon-sniper-notified-<key>,人工删掉即可重发。key 里带
 * 小时戳的调用点(usdm-unreadable)因此退化为"每小时最多一封",而不是永久静默
 * —— API 不可达是会自愈的状态,不该只提醒一次。
 */
async function notifyTerminal(key: string, subject: string, html: string): Promise<void> {
  if (!ONCE) {
    await notify(subject, html);
    return;
  }
  const flag = path.join(ROOT, "data", `oregon-sniper-notified-${key}`);
  if (fs.existsSync(flag)) {
    emit({ kind: "mail-suppressed", key, subject });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, `${new Date().toISOString()} ${subject}\n`);
  } catch (err) {
    // 写不进 sentinel 就退化为照常发信(宁可多一封,不可漏告警)。
    emit({ kind: "warn", msg: `sentinel 写入失败: ${err instanceof Error ? err.message : String(err)}` });
  }
  await notify(subject, html);
}

/** UTC 小时戳,给 notifyTerminal 的 key 做"每小时最多一封"的节流。 */
const hourKey = (): string => new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");

// ══ 纯函数区(导出供 tests/oregonSniper.test.ts 离线锁行为)══════════

export interface UsdmRow {
  mapDate?: string;
  stateAbbreviation?: string;
  d4?: number | string;
  statisticFormatID?: number;
}

export type UsdmKind = "holds" | "revoked" | "unreadable";

export interface UsdmVerdict {
  kind: UsdmKind;
  d4: number | null;
  reason: string;
  /** 传输层失败的原始细节(HTTP 码 / 错误名),由 readUsdm 填。
   * usdmVerdict 这个纯函数不填 —— 它看到的已经是 null,分不出"超时"还是
   * "502"还是"JSON 坏了",而这三者的排查路径完全不同。 */
  fetchErr?: string | null;
}

/**
 * R1 闸的判据核心:两个口径的返回行 → 三态裁决。
 *
 * 三态(而不是布尔)是本函数存在的全部理由。布尔化会把下面两件事合并成一件:
 *   · revoked    —— 明确读到 d4 < 1.00 ⟹ 触发被撤回,**落 kill-switch**
 *   · unreadable —— 空数组 / mapDate 不匹配 / 两口径不一致 / 字段非数
 *                   ⟹ **只停火,不 halt**
 * 合并的后果在两个方向上都是灾难:当成 revoked 处理会让一次 aoi 传错永久停掉
 * 整个系统(空数组 + HTTP 200 是这个 API 的已知静默失败形态);当成 holds 处理
 * 则等于 R1 闸根本不存在。
 *
 * 两口径一致性为什么是硬校验而不是"参考":D4 是最高级别,categorical 与
 * cumulative 在 d4 这一列**恒等**(无更高级可累加),08-08 实测两边都是 2.15。
 * 这是一条免费的、来自数据结构本身的正确性断言 —— 两边对不上只能是"读到了
 * 不同期次"或"API 变了口径",两种情况都不该继续下单。
 */
export function usdmVerdict(categorical: UsdmRow[] | null, cumulative: UsdmRow[] | null): UsdmVerdict {
  const pick = (rows: UsdmRow[] | null, label: string): { d4: number } | { err: string } => {
    if (rows == null) return { err: `${label} 请求失败` };
    if (!Array.isArray(rows) || rows.length === 0) {
      // 空数组 + HTTP 200 = 该 API 的静默失败形态(aoi 传字母码就是这样)。
      // 绝不可解读为"该州 d4 = 0"。
      return { err: `${label} 返回空数组(静默失败形态:参数错与无数据不可区分)` };
    }
    const row = rows.find((r) => String(r.mapDate ?? "").slice(0, 10) === TRIGGER_MAP_DATE_ISO);
    if (!row) {
      return { err: `${label} 无 mapDate=${TRIGGER_MAP_DATE_ISO} 的行(拿到 ${rows.map((r) => String(r.mapDate ?? "?").slice(0, 10)).join(",")})` };
    }
    if (String(row.stateAbbreviation ?? "").toUpperCase() !== "OR") {
      return { err: `${label} stateAbbreviation=${row.stateAbbreviation ?? "?"} ≠ OR(aoi 指向了别的州)` };
    }
    const d4 = Number(row.d4);
    if (!Number.isFinite(d4)) return { err: `${label} d4 字段非数值(${JSON.stringify(row.d4)})` };
    return { d4 };
  };

  const c = pick(categorical, "categorical");
  const u = pick(cumulative, "cumulative");
  if ("err" in c) return { kind: "unreadable", d4: null, reason: c.err };
  if ("err" in u) return { kind: "unreadable", d4: null, reason: u.err };
  if (c.d4 !== u.d4) {
    return {
      kind: "unreadable",
      d4: null,
      reason: `两口径 d4 不一致(categorical ${c.d4} vs cumulative ${u.d4})—— D4 为最高级本应恒等,读到了不同期次或 API 改了口径`,
    };
  }
  if (c.d4 < D4_THRESHOLD) {
    return {
      kind: "revoked",
      d4: c.d4,
      reason: `d4 ${c.d4} < 阈值 ${D4_THRESHOLD} —— 08-04 那期已被 NDMC 下修/撤回,YES 条件不再成立`,
    };
  }
  return { kind: "holds", d4: c.d4, reason: `d4 ${c.d4} ≥ ${D4_THRESHOLD}(两口径一致),触发仍然有效` };
}

export interface GammaMarket {
  id?: string;
  question?: string;
  conditionId?: string;
  questionID?: string;
  clobTokenIds?: string;
  outcomes?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number };
  description?: string;
  slug?: string;
  endDate?: string;
}

export interface IdentityResult {
  ok: boolean;
  problems: string[];
}

/**
 * 启动身份三校验 + 方向校验 + 条款校验(fail-closed,任一不过拒绝启动)。
 *
 * 为什么把 tokenId 写死再回头比对,而不是"从 Gamma 拿 Yes 腿就用":
 * Gamma 的 outcomes/clobTokenIds 是两个平行数组,靠**下标对齐**决定方向。
 * 一次平台侧的顺序变更、一次字段改名,都会让"取 Yes 腿"这段代码悄悄取到 No。
 * 这条盘的 YES 必然结算 $1、NO 必然结算 $0 —— 方向错不是少赚,是本金归零。
 * 所以这里做的是双向锁:下标要指向 "Yes",且那个位置的 tokenId 必须逐字等于
 * 08-08 实测到的常量。两条都过才认。
 */
export function identityCheck(m: GammaMarket | null | undefined): IdentityResult {
  const problems: string[] = [];
  if (!m) return { ok: false, problems: [`slug=${SLUG} 取不到市场`] };

  if (m.conditionId !== CONDITION_ID) problems.push(`conditionId 不符(期望 ${CONDITION_ID},实际 ${m.conditionId ?? "缺失"})`);
  if (m.questionID !== QUESTION_ID) problems.push(`questionID 不符(期望 ${QUESTION_ID},实际 ${m.questionID ?? "缺失"})`);

  let outcomes: string[] = [];
  let tokenIds: string[] = [];
  try {
    outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
    tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
  } catch {
    problems.push("outcomes/clobTokenIds 字段解析失败");
  }
  const yesIdx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === "yes");
  if (yesIdx < 0) {
    problems.push(`outcomes 里找不到 Yes(${JSON.stringify(outcomes)})`);
  } else if (tokenIds[yesIdx] !== YES_TOKEN_ID) {
    // 双向锁的第二把:下标对了但 token 不是那一个 —— 方向已经错了。
    problems.push(`Yes 腿 tokenId 不符(期望 ${YES_TOKEN_ID.slice(0, 20)}…,实际 ${String(tokenIds[yesIdx] ?? "缺失").slice(0, 20)}…)`);
  }

  const desc = m.description ?? "";
  for (const key of CLAUSE_MUST_CONTAIN) {
    if (!desc.includes(key)) problems.push(`条款关键句缺失:「${key}」—— 平台改了 description,全部推理失去依据`);
  }

  if (m.closed === true) problems.push("市场已 closed(可能已 finalize,窗口关闭)");
  if (m.acceptingOrders === false) problems.push("acceptingOrders=false(交易所已停止接单)");

  return { ok: problems.length === 0, problems };
}

/**
 * 额度 env 钉法(与 release-sniper.execCapPins 同源思路,但多钉一条 daily)。
 *
 * perToken 必须钉:默认 = EXEC_MAX_ORDER_USD($100),第一笔满仓成交后
 * tokenExposure 立刻触顶,该 token 被永久封死,补仓一次也做不成。
 * perEvent 必须一起钉:默认 = 2×单笔,在 executeSignal 的 min() 里会**先于**
 * per-token 咬住(08-07 核验 §1.4 实测:只钉 per-token 时声明的 4× 容量永远
 * 只能兑现 2×)。本盘是单腿单事件,事件帽在此退化为一道更严的 token 帽。
 * daily 只在 budget 超过它时才钉,且**取 max 不覆盖**:不能因为参数给小了就
 * 把生产日额度调低,那会静默影响同日的 chain-watch。
 *
 * 返回值里的 dailyRaised 是给调用方发告警用的 —— 抬日额度会等额挤占同日其他
 * 管线的容量,这件事必须说破,不能静默发生。
 */
export function execCapPins(
  budget: number,
  env: Record<string, string | undefined>,
  opts: { raiseMaxOrder?: boolean } = {}
): { perToken: string; perEvent: string; daily: string; maxOrder: string; dailyRaised: boolean; maxOrderRaised: boolean } {
  const envDaily = Number(env.EXEC_DAILY_MAX_USD ?? "150");
  const curDaily = Number.isFinite(envDaily) ? envDaily : 150;
  // 默认 50 与 execConfig 的 num("EXEC_MAX_ORDER_USD", 50) 逐字同源。
  const envMaxOrder = Number(env.EXEC_MAX_ORDER_USD ?? "50");
  const curMaxOrder = Number.isFinite(envMaxOrder) ? envMaxOrder : 50;
  // 单笔上限只在**显式命中某个 --tier 档**时才抬(2026-08-08 用户裁决 A 方案)。
  //
  // 为什么它是必要的:低价档把 per-token/日额度抬到 $800 之后,真正的限速器变成
  // 了单笔 $100 —— cron 每 10 分钟一轮,吃满 $378 要 4 轮 40 分钟。而 ask ≤ 0.80
  // 意味着有人在明显低于合理价的位置抛售,那种单子更可能被别人抢走,40 分钟的
  // 窗口不够。
  //
  // 为什么 fallback 档不抬:fallback 是"常规档",应当维持生产 .env 的默认行为。
  // tier 是调用方显式声明的激进档,放开它是有意的;把 fallback 也一起放开等于
  // 悄悄改掉了这条管线的常规风控。
  const maxOrderRaised = opts.raiseMaxOrder === true && budget > curMaxOrder;
  return {
    perToken: String(budget),
    perEvent: String(budget),
    daily: String(Math.max(curDaily, budget)),
    maxOrder: String(opts.raiseMaxOrder === true ? Math.max(curMaxOrder, budget) : curMaxOrder),
    dailyRaised: budget > curDaily,
    maxOrderRaised,
  };
  // 返回值里**没有** total —— EXEC_TOTAL_MAX_USD(未结算总敞口)不在本函数的
  // 职责内,也没有任何调用方入口。它保护的是"所有判断同时错"的账户级情形,
  // 分层对它无话可说,因此它始终是实际硬顶。测试按"返回 key 集合不含 total"
  // 断言这一点。
}

export interface BudgetTier {
  /** ask ≤ 这个价 时启用 usd 这个预算。 */
  maxAsk: number;
  usd: number;
}

/**
 * `--tier <价>:<预算>` 的解析(可重复给,顺序无关 —— 内部按价升序)。
 *
 * 非法项一律**丢弃并留痕**而不是回退到某个默认值:一个手滑的 `--tier 0.8:abc`
 * 若被解读成"预算 NaN",在 executeSignal 的 min() 里会静默把订单缩成 0,表现
 * 为"引擎不买了"而日志上看不出原因。
 */
export function parseTiers(raw: string[]): { tiers: BudgetTier[]; bad: string[] } {
  const tiers: BudgetTier[] = [];
  const bad: string[] = [];
  for (const item of raw) {
    const m = /^([0-9]*\.?[0-9]+):([0-9]*\.?[0-9]+)$/.exec(item.trim());
    const maxAsk = m ? Number(m[1]) : NaN;
    const usd = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(maxAsk) || !Number.isFinite(usd) || maxAsk <= 0 || maxAsk > 1 || usd <= 0) {
      bad.push(item);
      continue;
    }
    tiers.push({ maxAsk, usd });
  }
  tiers.sort((a, b) => a.maxAsk - b.maxAsk);
  return { tiers, bad };
}

/**
 * 按本轮 ask 选预算 —— "风控闸门按机会质量分级"(2026-08-08 用户裁决)。
 *
 * 为什么需要它:一刀切的 per-token / 日额度是为**未知质量的信号**设的。用同一个
 * $330 去约束 ask 0.72(净回报 38.9%)和 ask 0.90(11.1%)两种腿,是拿通用闸门
 * 约束特例。凯利判据在 ask=0.82 / q=2% 下给出 f*≈89%,即现有仓位远低于最优 ——
 * 低价档理应有更大的容量。
 *
 * 取**第一个** ask ≤ maxAsk 的档(已升序):低价档优先,天然实现"越便宜容量越大"。
 * 未命中任何档 → fallback(= --budget),也就是"贵的腿维持原额度"。
 *
 * ⚠ 它**只放宽 per-token / per-event / daily 这三个"单机会规模"闸**。
 * `EXEC_TOTAL_MAX_USD`(未结算总敞口)刻意不提供任何放宽入口:那道闸保护的不是
 * 某个判断,而是"所有判断同时错"的账户级情形,分层逻辑对它无话可说。因此本
 * 函数返回多大,实际能买到的仍被总敞口余量硬封 —— 这是设计,不是遗漏。
 */
export function budgetForAsk(ask: number | null, tiers: BudgetTier[], fallback: number): { usd: number; tier: BudgetTier | null } {
  if (ask == null) return { usd: fallback, tier: null };
  for (const t of tiers) {
    if (ask <= t.maxAsk) return { usd: t.usd, tier: t };
  }
  return { usd: fallback, tier: null };
}

/**
 * 市场状态三态 —— 与 USDM 的三态同构,理由也同构。
 *
 * `unreadable` 这一态是 2026-08-09 修的一个真实缺陷:此前循环里写的是
 *   `const marketOpen = m != null && m.closed !== true && ...`
 * 于是 Gamma 抓取失败(m == null)与"市场真的 closed"合并成同一个 false,
 * 守盘器会因为**一次几秒的网络抖动**判定"市场已关闭"、发一封收工邮件、
 * 然后 return 退出 —— 而窗口其实还开着、仓位还等着补。08-08 18:00 与
 * 08-09 02:10 两次外部源瞬断(各 1 次、下一轮即自愈)正是这条路径的实证。
 * 读不到 ≠ 已关闭,和"读不到 ≠ 被撤回"是同一条纪律。
 */
export type MarketState = "open" | "closed" | "unreadable";

export interface FireInput {
  ask: number | null;
  maxPrice: number;
  usdm: UsdmKind;
  /** 距上次 USDM 成功读数的毫秒数;从未成功过传 Infinity。 */
  usdmAgeMs: number;
  usdmStaleMs: number;
  market: MarketState;
}

export interface FireDecision {
  fire: boolean;
  /** 需要落 kill-switch 并整体退出(触发被撤回)。 */
  halt: boolean;
  /** 需要发一封人工告警(USDM 长时间读不到)。 */
  alert: boolean;
  /** 市场**确证**已关闭 ⟹ 收工退出。抓不到市场时恒为 false。 */
  closed: boolean;
  why: string;
}

/**
 * 每轮开火判据(导出供离线测试逐条锁死)。
 *
 * 顺序即优先级,而这个顺序不是随意的:
 *   revoked 必须排在最前 —— 它是唯一需要**停掉整个系统**的状态,任何"盘口没货
 *   所以先 return"的短路都会把这条硬闸旁路掉(闸门被数据可用性掩盖是审计里
 *   反复出现的形态)。
 * 其后才是 unreadable(停火)→ 市场关闭(退出)→ 市场读不到(停火)→ 盘口。
 *
 * 注意最后两条的**顺序与语义差**:closed 是确证的终态 ⟹ 收工;market
 * unreadable 只是这一轮没读到 ⟹ 与 USDM unreadable 同款处理,停火等下一轮,
 * 绝不 return。把它们合并回布尔就是 2026-08-09 修掉的那个缺陷。
 */
export function fireDecision(i: FireInput): FireDecision {
  if (i.usdm === "revoked") {
    return { fire: false, halt: true, alert: true, closed: false, why: "USDM 判定:触发已被撤回/下修" };
  }
  if (i.usdm === "unreadable") {
    const stale = i.usdmAgeMs > i.usdmStaleMs;
    return {
      fire: false,
      halt: false,
      alert: stale,
      closed: false,
      why: stale
        ? `USDM 连续 ${Math.round(i.usdmAgeMs / 60_000)} 分钟读不到(> ${Math.round(i.usdmStaleMs / 60_000)} 分阈值),持续停火并告警`
        : "USDM 本轮读不到,停火等下一轮(未超 stale 阈值)",
    };
  }
  if (i.market === "closed") {
    return { fire: false, halt: false, alert: false, closed: true, why: "市场已关闭/停止接单(可能已 finalize)" };
  }
  if (i.market === "unreadable") {
    return { fire: false, halt: false, alert: false, closed: false, why: "本轮取不到市场状态,停火等下一轮(读不到 ≠ 已关闭)" };
  }
  if (i.ask == null) {
    return { fire: false, halt: false, alert: false, closed: false, why: "盘口无卖单,taker 不可成交" };
  }
  if (i.ask > i.maxPrice) {
    return { fire: false, halt: false, alert: false, closed: false, why: `ask ${i.ask} > 追高闸 ${i.maxPrice},不追高` };
  }
  return { fire: true, halt: false, alert: false, closed: false, why: `ask ${i.ask} ≤ ${i.maxPrice},触发有效,开火` };
}

// ── 外部源读不到:轮内重试 + 跨轮连败计数 ──────────────────────

/** 带诊断的抓取结果。失败时**必须**带上可排查的原因 —— 把 HTTP 502、
 * TimeoutError、JSON 解析失败一律压成 `null` 正是 08-08/08-09 两次事故
 * 无法当场定性的原因:日志上"取不到市场"与"市场没了"长得一模一样。 */
export type FetchOutcome<T> = { ok: true; data: T } | { ok: false; err: string };

/** 轮内重试的退避梯度。秒级即可 —— 两次实测故障都是几秒内快速失败、
 * 下一轮(10 分钟后)自愈,属于对端瞬时拒绝而非持续不可达。 */
export const RETRY_BACKOFF_MS = [1_000, 3_000];

/**
 * 失败重试(纯逻辑,sleep 可注入 ⟹ 测试里零延时跑完)。
 *
 * 为什么重试要放在**轮内**而不是"等下一轮 cron":守盘器每轮都是一次独立的
 * 机会评估,一轮丢掉 = 10 分钟盘口无人看管。而实测这两类失败在 1 秒后重试
 * 就能过 —— 用几秒换一整轮,是这段代码存在的全部理由。
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<FetchOutcome<T>>,
  backoffMs: number[] = RETRY_BACKOFF_MS,
  sleepFn: (ms: number) => Promise<void> = sleep
): Promise<{ outcome: FetchOutcome<T>; tries: number; errors: string[] }> {
  const errors: string[] = [];
  for (let i = 0; i <= backoffMs.length; i += 1) {
    const outcome = await attempt(i + 1);
    if (outcome.ok) return { outcome, tries: i + 1, errors };
    errors.push(outcome.err);
    if (i < backoffMs.length) await sleepFn(backoffMs[i]!);
  }
  return {
    outcome: { ok: false, err: errors[errors.length - 1] ?? "未知错误" },
    tries: backoffMs.length + 1,
    errors,
  };
}

/** 一个外部源连续读不到的跨轮状态。cron `--once` 每轮是独立进程,
 * 内存计数恒为 1 —— 必须落盘才能表达"连续"。 */
export interface TransientState {
  count: number;
  firstAtIso: string | null;
  lastErr: string | null;
}

/**
 * "读不到"该不该升级成告警邮件。
 *
 * 门槛存在的理由是实测数据:oregon-sniper 上线以来 52 轮 Gamma 里 1 轮抓不到、
 * 99 轮 USDM 里 1 轮读不到,**两次都在下一轮自愈**。单轮失败即发红色 🛑 邮件,
 * 等于用一个 1-2% 概率的自愈事件去消耗收件人的注意力,而真正需要人动手的事
 * (触发被撤回、条款被改写)会被埋在同样的红色里 —— 被噪音淹掉的告警等于
 * 没有告警,这条纪律在本文件的 notifyTerminal 注释里已经写过一次。
 *
 * ⚠ 只对**会自愈**的状态用它。revoked、身份/条款不符、市场确证关闭都不走
 * 这条路:它们不会自己好,晚一轮知道就是晚一轮的损失。
 */
export function transientDecision(
  prev: TransientState | null,
  nowIso: string,
  err: string,
  threshold: number
): { next: TransientState; alert: boolean } {
  const count = (prev?.count ?? 0) + 1;
  return {
    next: { count, firstAtIso: prev?.firstAtIso ?? nowIso, lastErr: err },
    // 达到阈值后**每轮**都返回 true,由 notifyTerminal 的小时戳 key 收成
    // "每小时最多一封" —— 持续故障应当持续提醒,只是不必每 10 分钟一封。
    alert: count >= Math.max(1, threshold),
  };
}

/** ledger skip 原因 → 是否"额度/深度已耗尽"(耗尽后降频轮询,不刷屏也不空转)。
 * 词干与 tradeExecutor 里的文案对齐;那边的 "累计敞口已满" 是 gonogo-materials
 * 也在用的稳定词干,改文案会同时打断两处。 */
export function isExhausted(reason: string | undefined): boolean {
  if (!reason) return false;
  return /累计敞口已满|日额度已满|未结算持仓已满|同事件聚合敞口已满|额度\/限价内深度不足/.test(reason);
}

// ══ IO 区 ═════════════════════════════════════════════════════

/** 带诊断的抓取。失败原因逐字保留 —— 见 FetchOutcome 的注释。 */
async function fetchJson<T>(url: string, ms: number): Promise<FetchOutcome<T>> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { ok: false, err: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    // name 与 message 都要:AbortSignal.timeout 抛的是 TimeoutError,而代理
    // 瞬断抛的是 TypeError: fetch failed —— 两者的排查路径完全不同。
    return { ok: false, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** 只关心成败、不关心原因的旧调用点(readBook)继续用它。 */
async function getJson<T>(url: string, ms = 20_000): Promise<T | null> {
  const r = await fetchJson<T>(url, ms);
  return r.ok ? r.data : null;
}

// ── 连败计数的落盘(纯判据在 transientDecision,这里只管读写)────

const transientFile = (key: string): string => path.join(ROOT, "data", `oregon-sniper-transient-${key}.json`);

function readTransient(key: string): TransientState | null {
  try {
    const raw = fs.readFileSync(transientFile(key), "utf8");
    const s = JSON.parse(raw) as Partial<TransientState>;
    if (typeof s.count !== "number" || !Number.isFinite(s.count)) return null;
    return { count: s.count, firstAtIso: s.firstAtIso ?? null, lastErr: s.lastErr ?? null };
  } catch {
    // 文件不存在 / 内容损坏 —— 都当"没有连败史"。读不出计数绝不能反过来
    // 阻塞主流程,最坏结果只是多发一封信。
    return null;
  }
}

function writeTransient(key: string, s: TransientState): void {
  try {
    fs.mkdirSync(path.dirname(transientFile(key)), { recursive: true });
    fs.writeFileSync(transientFile(key), JSON.stringify(s) + "\n");
  } catch (err) {
    emit({ kind: "warn", msg: `连败计数写入失败(${key}): ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** 读成功了就把连败史抹掉 —— 否则"上周那次抖动"会和今天这次拼成连败。 */
function clearTransient(key: string): void {
  try {
    fs.rmSync(transientFile(key), { force: true });
  } catch {
    /* 清不掉最多是多发一封信,不值得打断主流程 */
  }
}

function usdmUrl(statisticsType: 1 | 2): string {
  return (
    `${USDM_API}?aoi=${OREGON_FIPS}` +
    `&startdate=${encodeURIComponent(TRIGGER_MAP_DATE)}&enddate=${encodeURIComponent(TRIGGER_MAP_DATE)}` +
    `&statisticsType=${statisticsType}`
  );
}

/** 两个口径**并发**拉(它们互为一致性校验,串行只是白白多花一倍时间);
 * 每一路各自带轮内重试 —— 08-09 02:10 那次正是两路里 cumulative 单边失败。 */
async function readUsdm(): Promise<UsdmVerdict> {
  const [cat, cum] = await Promise.all([
    withRetry<UsdmRow[]>(() => fetchJson<UsdmRow[]>(usdmUrl(2), 25_000)),
    withRetry<UsdmRow[]>(() => fetchJson<UsdmRow[]>(usdmUrl(1), 25_000)),
  ]);
  const v = usdmVerdict(
    cat.outcome.ok ? cat.outcome.data : null,
    cum.outcome.ok ? cum.outcome.data : null
  );
  const errs = [
    cat.outcome.ok ? null : `categorical ${cat.outcome.err}(试 ${cat.tries} 次)`,
    cum.outcome.ok ? null : `cumulative ${cum.outcome.err}(试 ${cum.tries} 次)`,
  ].filter((x): x is string => x != null);
  if (errs.length === 0) return { ...v, fetchErr: null };
  // 传输层原因附在 reason 后面:usdmVerdict 只能说"cumulative 请求失败",
  // 而人要看的是"失败成什么样"。
  return { ...v, reason: `${v.reason} —— ${errs.join(";")}`, fetchErr: errs.join(";") };
}

/** 市场读取的三态结果。`err != null` = **传输层**没读到(与"平台说这条盘
 * 不存在"分开:后者 err 也非 null,但文案里写明 HTTP 200,排查路径不同)。 */
interface MarketRead {
  market: GammaMarket | null;
  err: string | null;
  tries: number;
}

async function fetchMarket(): Promise<MarketRead> {
  const { outcome, tries, errors } = await withRetry<GammaMarket[]>(() =>
    fetchJson<GammaMarket[]>(`${GAMMA_API}/markets?slug=${SLUG}`, 20_000)
  );
  if (!outcome.ok) {
    return { market: null, err: `${outcome.err}(试 ${tries} 次:${errors.join(" | ")})`, tries };
  }
  const m = outcome.data?.[0] ?? null;
  if (m == null) {
    const n = Array.isArray(outcome.data) ? `${outcome.data.length} 条` : "非数组";
    return { market: null, err: `HTTP 200 但 slug 无匹配市场(返回 ${n})`, tries };
  }
  return { market: m, err: null, tries };
}

interface BookSnapshot {
  bestAsk: number | null;
  /** ≤ maxPrice 的挂单合计成本与股数 —— 日志里看"还剩多少肉"。 */
  depthUsd: number;
  depthShares: number;
  levels: Array<{ price: number; size: number }>;
}

async function readBook(): Promise<BookSnapshot | null> {
  const b = await getJson<{ asks?: Array<{ price: string; size: string }> }>(
    `${CLOB_API}/book?token_id=${YES_TOKEN_ID}`,
    12_000
  );
  if (b == null) return null;
  const levels = (b.asks ?? [])
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    .sort((x, y) => x.price - y.price);
  const inCap = levels.filter((l) => l.price <= MAX_PRICE);
  return {
    bestAsk: levels[0]?.price ?? null,
    depthUsd: inCap.reduce((s, l) => s + l.price * l.size, 0),
    depthShares: inCap.reduce((s, l) => s + l.size, 0),
    levels,
  };
}

// ── 下单 ───────────────────────────────────────────────────────

async function fireOnce(m: GammaMarket, ask: number, tag: string): Promise<TradeAttempt> {
  const attempt = await executeSignal({
    qid: QUESTION_ID,
    tokenId: YES_TOKEN_ID,
    conditionId: CONDITION_ID,
    eventId: EVENT_ID,
    outcome: "Yes",
    question: m.question ?? "Will Oregon reach D4 (Exceptional Drought) by August 31, 2026?",
    marketUrl: `https://polymarket.com/market/${SLUG}`,
    label: `🎯 oregon-sniper D4=已触发 → Yes${tag ? ` ${tag}` : ""}`,
    stance: "oregon_d4_triggered",
    llmStance: null,
    llmConfidence: null,
    // 数据已发布、条款已满足 = 事件已决,不是预告期。
    llmEventStatus: "decided",
    // 锚取**本轮刚拉到的** ask:这是主动决策买入,不是跟随信号,漂移带在此
    // 无意义(它防的是"注解到下单之间市场重新定价了");不追高由 --max-price
    // 这道更硬的闸负责。
    bestAskAtSignal: ask,
    bookEmpty: false,
    // 官方数字直接决定结算,与"宣告类裁定"同语义 —— 启用按边缩放的限价带,
    // 让 FAK 一次能扫穿几个价档而不是只吃簿顶一格。
    declarative: true,
    dirMethod: "outcome-exact",
    negRisk: m.negRisk === true,
    feesEnabled: m.feesEnabled ?? null,
    feeRate: typeof m.feeSchedule?.rate === "number" ? m.feeSchedule.rate : null,
    forecastTemplate: false,
    maxPriceCap: EXEC_PRICE_CAP,
    budgetMs: 120_000,
  });
  emit({
    kind: "trade",
    tag,
    ask,
    priceCap: EXEC_PRICE_CAP,
    status: attempt.status,
    reason: attempt.reason,
    requestedUsd: attempt.requestedUsd,
    filledUsd: attempt.filledUsd,
    avgPrice: attempt.avgPrice,
    limitPrice: attempt.limitPrice,
    orderId: attempt.orderId,
  });
  // 成交均价事后核对(与 release-sniper 同款):限价封的是**最坏**成交价,
  // 均价是限价以下扫到哪算哪的加权值。均价越过 --max-price 不代表下单错了,
  // 代表这个参数的直觉含义与实际行为分了岔 —— 必须当场留一行,而不是等下次
  // 审计从 ledger 里考古。
  if (attempt.avgPrice != null && attempt.avgPrice > MAX_PRICE) {
    emit({
      kind: "avg-price-over-cap",
      tag,
      avgPrice: attempt.avgPrice,
      maxPrice: MAX_PRICE,
      limitPrice: attempt.limitPrice,
      note: "--max-price 是追高闸(封本轮 ask),不是成交均价上限",
    });
  }
  return attempt;
}

// ── 主循环 ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  emit({
    kind: "start",
    slug: SLUG,
    maxPrice: MAX_PRICE,
    execPriceCap: EXEC_PRICE_CAP,
    budget: BUDGET,
    armed: ARMED,
    once: ONCE,
    ...(SIMULATE_REVOKED ? { simulateRevoked: true } : {}),
    envExecMode: executionMode(),
    pollSec: POLL_MS / 1000,
    out: OUT,
  });

  // --arm 未给 → 强制 dry。一个没显式武装的进程绝不允许因为环境变量就开始花钱。
  if (!ARMED) {
    process.env.EXEC_MODE = "dry";
    emit({ kind: "safety", msg: "未给 --arm,已强制 EXEC_MODE=dry(不会真下单)" });
  }
  const { tiers, bad } = parseTiers(TIER_ARGS);
  if (bad.length > 0) {
    // 非法 tier 不静默丢:它的现场症状是"引擎莫名不买了",最难排查的那一类。
    emit({ kind: "fatal", msg: `--tier 格式非法,拒绝启动:${bad.join(" | ")}(正确形如 0.85:600)` });
    await notifyTerminal(
      `tier-bad-${hourKey()}`,
      "🛑 oregon-sniper 拒绝启动:--tier 参数非法",
      `<p>未下任何单。非法项:<code>${bad.join(" | ")}</code></p><p>正确格式 <code>--tier 0.85:600</code>(价:预算)。</p>`
    );
    process.exit(1);
  }

  /** 日额度与单笔上限的**原始** env 值。applyCaps 每轮都要以它们为基线重算 ——
   * 若拿上一轮写回的 process.env 当基线,`Math.max(cur, budget)` 会单调爬升:
   * 一次 0.72 档抬到 $800 之后,后面所有轮次(哪怕 ask 0.90 该回落到 $330)都
   * 永久停在 $800。这个错误在日志上只表现为一个偏大的数字,不会报错。 */
  const dailyBefore = process.env.EXEC_DAILY_MAX_USD ?? "(未设,默认 150)";
  const dailyBaseline = process.env.EXEC_DAILY_MAX_USD;
  const maxOrderBefore = process.env.EXEC_MAX_ORDER_USD ?? "(未设,默认 50)";
  const maxOrderBaseline = process.env.EXEC_MAX_ORDER_USD;

  /** 每轮按当轮 ask 重设四个"单机会规模"闸(executeSignal 读 env,而 ask 每轮
   * 在动)。刻意每轮重设而不是启动时钉一次:分层的全部意义就是"这一档多少钱
   * 由这一档的价格决定"。总敞口 EXEC_TOTAL_MAX_USD 从不触碰,见 budgetForAsk。
   *
   * 单笔上限只在命中 tier 时抬(raiseMaxOrder = tier != null):低价档把 per-token
   * 抬到 $800 后,真正的限速器就变成单笔 $100 —— cron 每 10 分钟一轮,吃满 $378
   * 要 4 轮 40 分钟,而低价抛单更容易被别人抢走。fallback 档维持生产默认。 */
  const applyCaps = (ask: number | null): { usd: number; tier: BudgetTier | null; pins: ReturnType<typeof execCapPins> } => {
    const { usd, tier } = budgetForAsk(ask, tiers, BUDGET);
    const p = execCapPins(
      usd,
      { ...process.env, EXEC_DAILY_MAX_USD: dailyBaseline, EXEC_MAX_ORDER_USD: maxOrderBaseline },
      { raiseMaxOrder: tier != null }
    );
    process.env.EXEC_PER_TOKEN_MAX_USD = p.perToken;
    process.env.EXEC_PER_EVENT_MAX_USD = p.perEvent;
    process.env.EXEC_DAILY_MAX_USD = p.daily;
    process.env.EXEC_MAX_ORDER_USD = p.maxOrder;
    return { usd, tier, pins: p };
  };

  const pins = applyCaps(null).pins; // 启动时按 fallback 预算钉一次
  emit({
    kind: "caps",
    perToken: pins.perToken,
    perEvent: pins.perEvent,
    dailyBefore,
    daily: pins.daily,
    dailyRaised: pins.dailyRaised,
    maxOrderBefore,
    maxOrderUsd: execConfig().maxOrderUsd,
    totalMaxUsd: execConfig().totalMaxUsd,
    tiers: tiers.map((t) => `ask≤${t.maxAsk}→$${t.usd}`),
    fallbackBudget: BUDGET,
    note:
      (pins.dailyRaised
        ? `日额度已在本进程内从 $${dailyBefore} 抬到 $${pins.daily};同日 chain-watch 的可用额度被等额挤占。`
        : "日额度未改动。") +
      (tiers.length > 0
        ? `分层已启用,每轮按 ask 重算(命中 tier 时单笔上限一并抬到当档预算,` +
          `fallback 档维持 $${maxOrderBefore});总敞口 $${execConfig().totalMaxUsd} 不受分层影响,是实际硬顶。`
        : ""),
  });

  // ── 启动硬门槛 ①:身份 + 方向 + 条款 ──
  // 两类失败刻意分道:**读不到**(会自愈,连败到阈值才吵)与**读到了但不对**
  // (不会自愈,第一轮就吵)。合并成一条红色告警正是 08-08/08-09 噪音的来源。
  const read = await fetchMarket();
  if (read.err != null) {
    const t = transientDecision(readTransient("gamma"), new Date().toISOString(), read.err, ALERT_AFTER);
    writeTransient("gamma", t.next);
    emit({
      kind: "fatal",
      msg: "取不到市场,拒绝启动(读不到 ≠ 市场已关闭)",
      err: read.err,
      tries: read.tries,
      streak: t.next.count,
      alertAfter: ALERT_AFTER,
      alerted: t.alert,
    });
    if (t.alert) {
      await notifyTerminal(
        `gamma-unreadable-${hourKey()}`,
        `⚠️ oregon-sniper 连续 ${t.next.count} 轮取不到市场(Gamma)`,
        `<p>未下任何单。<b>这不代表市场被关闭</b> —— 是 Gamma 没读到。</p>` +
          `<p>最后一次原因:<code>${read.err}</code></p>` +
          `<p>首次失败:${t.next.firstAtIso} · 连续 ${t.next.count} 轮(阈值 ${ALERT_AFTER})· 每轮已重试 ${read.tries} 次</p>` +
          `<p>先查代理可达性;市场真被下架会走另一条判据(closed/acceptingOrders),文案不同。</p>`
      );
    }
    process.exit(1);
  }
  clearTransient("gamma");
  const market = read.market;
  const id = identityCheck(market);
  if (!id.ok) {
    emit({ kind: "fatal", msg: "身份/条款校验失败,拒绝启动", problems: id.problems });
    await notifyTerminal(
      `identity-${hourKey()}`,
      "🛑 oregon-sniper 拒绝启动:身份或条款校验失败",
      `<p>未下任何单。<b>市场读到了,但内容与写死的常量不符</b> —— 这类问题不会自愈。问题:</p>` +
        `<ul>${id.problems.map((p) => `<li>${p}</li>`).join("")}</ul>`
    );
    process.exit(1);
  }
  emit({ kind: "identity-ok", question: market!.question, endDate: market!.endDate, negRisk: market!.negRisk });

  // ── 启动硬门槛 ②:USDM 首轮必须读到且达标 ──
  // 首轮不允许 unreadable 兜底:守盘器的全部合法性来自"触发确实还在",
  // 连一次都没确认过就开始下单,等于把 R1 闸推迟到不知道什么时候。
  let usdm = await readUsdm();
  let usdmOkAt = usdm.kind === "holds" ? Date.now() : 0;
  // verdict 而非展开 ...usdm:UsdmVerdict 自己带一个 kind 字段,展开会把日志行
  // 的 kind 从 "usdm" 覆盖成 "holds"/"revoked",按 kind 过滤日志时整类行消失。
  emit({ kind: "usdm", verdict: usdm.kind, d4: usdm.d4, reason: usdm.reason, fetchErr: usdm.fetchErr ?? null, mapDate: TRIGGER_MAP_DATE_ISO });
  if (usdm.kind === "revoked") {
    // 撤回不会自愈,也不该等 —— 第一轮就发,且 key 不带小时戳(终态,只发一次)。
    emit({ kind: "fatal", msg: "USDM 首轮校验未通过(revoked),拒绝启动" });
    await notifyTerminal(
      "usdm-revoked",
      "🛑 oregon-sniper 拒绝启动:USDM 首轮 revoked",
      `<p>未下任何单。${usdm.reason}</p><p><b>这是 R1 实现了 —— 触发已被撤回,这条盘不再可做。</b></p>`
    );
    process.exit(1);
  }
  if (usdm.kind !== "holds") {
    const t = transientDecision(readTransient("usdm"), new Date().toISOString(), usdm.reason, ALERT_AFTER);
    writeTransient("usdm", t.next);
    emit({
      kind: "fatal",
      msg: "USDM 首轮校验未通过(unreadable),拒绝启动",
      streak: t.next.count,
      alertAfter: ALERT_AFTER,
      alerted: t.alert,
    });
    if (t.alert) {
      await notifyTerminal(
        `usdm-unreadable-${hourKey()}`,
        `⚠️ oregon-sniper 连续 ${t.next.count} 轮读不到 USDM`,
        `<p>未下任何单。<b>读不到 ≠ 被撤回</b>,kill-switch 未落、仓位未动。</p>` +
          `<p>最后一次原因:${usdm.reason}</p>` +
          `<p>首次失败:${t.next.firstAtIso} · 连续 ${t.next.count} 轮(阈值 ${ALERT_AFTER})</p>` +
          `<p>先排查代理/API 可达性(注意 aoi 必须是 FIPS 数字码 41,传 OR 会返回空数组 + HTTP 200)。</p>`
      );
    }
    process.exit(1);
  }
  clearTransient("usdm");

  const cfg = execConfig();
  // 上线邮件在 --once(cron 模式)下必须闭嘴:每 10 分钟一封 = 144 封/天,
  // 而这封信的全部信息量是"我启动了" —— 真正需要送达的(成交、撤回、市场关闭)
  // 都有各自的邮件,不受影响。被噪音淹掉的告警等于没有告警。
  if (!ONCE) {
    await notify(
      `🎯 oregon-sniper 上线(${ARMED ? "实弹" : "DRY"})· D4=${usdm.d4}% 触发有效`,
        `<p>标的:${market!.question}</p>` +
        `<p>USDM 08-04 期 Oregon D4 = <b>${usdm.d4}%</b> ≥ ${D4_THRESHOLD}%(两口径一致),触发有效。</p>` +
        `<p>模式:<b>${ARMED ? "实弹" : "DRY(未给 --arm)"}</b> · 追高闸 ${MAX_PRICE}(最坏成交价 ${EXEC_PRICE_CAP.toFixed(3)})</p>` +
        `<p>预算 $${BUDGET} · 单笔 $${cfg.maxOrderUsd} · 日 $${pins.daily}${pins.dailyRaised ? "(本进程内已抬高)" : ""} · 轮询 ${POLL_MS / 1000}s</p>` +
        `<p>R1 监控:每 ${USDM_TTL_MS / 60_000} 分钟重核一次;读到 d4 &lt; 1.00 立即落 kill-switch 并退出。</p>`
    );
  }

  let filledTotal = 0;
  let round = 0;
  let exhaustedStreak = 0;
  let lastAlertAt = 0;
  let lastIdleWhy = "";
  let idleRepeats = 0;
  /** 把积压的 idle 重复计数结成一行。每个出口都要调 —— 少调一处,那段"什么
   * 都没发生"的时长就在日志上凭空消失,而事后复盘恰恰要靠它区分"守了 9 小时
   * 没肉"和"进程其实早就卡住了"。 */
  const flushIdle = (): void => {
    if (idleRepeats > 0) emit({ kind: "idle-repeat", why: lastIdleWhy, repeats: idleRepeats });
    idleRepeats = 0;
    lastIdleWhy = "";
  };

  while (Date.now() - startedAt < MAX_RUN_MS) {
    round += 1;

    // 自检注入点在主循环而非首轮:首轮的 revoked 走的是"拒绝启动"分支
    // (process.exit),而要验证的是**守盘途中撤回**这条路径 —— 已开火、已可能
    // 持仓,系统要落 kill-switch 并把"手上有货"这件事告诉人。
    if (SIMULATE_REVOKED) {
      usdm = { kind: "revoked", d4: 0.0, reason: "【--simulate-revoked 自检】强制判定为撤回,非真实数据" };
    }

    // R1 重核:TTL 内复用上次成功读数,到期重拉。unreadable 时**不覆盖**上次
    // 成功的时间戳 —— usdmAgeMs 正是靠它衡量"多久没确认过了"。
    if (Date.now() - usdmOkAt >= USDM_TTL_MS) {
      const fresh = await readUsdm();
      if (fresh.kind !== usdm.kind || fresh.d4 !== usdm.d4) {
        emit({ kind: "usdm", verdict: fresh.kind, d4: fresh.d4, reason: fresh.reason, round });
      }
      usdm = fresh;
      if (fresh.kind === "holds") usdmOkAt = Date.now();
    }

    // 市场状态:已 finalize / 停止接单就没什么可守的了。每轮重拉一次,
    // 这也是"7 天 holding 期到底哪天结束"那个未闭环项(R2)的实际观测点。
    // ⚠ 三态而非布尔:抓不到时**不能**当成已关闭,否则一次网络抖动就让守盘器
    //   发一封"收工"邮件然后退出,而窗口还开着(2026-08-09 修)。
    const mr = await fetchMarket();
    const m = mr.market;
    const marketState: MarketState =
      mr.err != null ? "unreadable" : m!.closed === true || m!.acceptingOrders === false ? "closed" : "open";
    if (marketState === "unreadable") {
      const t = transientDecision(readTransient("gamma"), new Date().toISOString(), mr.err!, ALERT_AFTER);
      writeTransient("gamma", t.next);
      emit({ kind: "market-unreadable", round, err: mr.err, tries: mr.tries, streak: t.next.count });
    } else {
      clearTransient("gamma");
    }

    const book = marketState === "open" ? await readBook() : null;
    const decision = fireDecision({
      ask: book?.bestAsk ?? null,
      maxPrice: MAX_PRICE,
      usdm: usdm.kind,
      usdmAgeMs: usdmOkAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - usdmOkAt,
      usdmStaleMs: USDM_STALE_MS,
      market: marketState,
    });

    // ── R1 实现:落 kill-switch,停掉的是**整个系统**,不只是本进程 ──
    if (decision.halt) {
      const haltFile = execConfig().haltFile;
      try {
        fs.mkdirSync(path.dirname(haltFile), { recursive: true });
        fs.writeFileSync(haltFile, `oregon-sniper R1: ${usdm.reason} @ ${new Date().toISOString()}\n`);
      } catch (err) {
        emit({ kind: "warn", msg: `kill-switch 写入失败: ${err instanceof Error ? err.message : String(err)}` });
      }
      flushIdle();
      emit({ kind: "halt", reason: usdm.reason, haltFile, filledTotal });
      await notifyTerminal(
        "halt",
        "⛔ oregon-sniper 触发撤回,已落 kill-switch",
        `<p><b>${usdm.reason}</b></p>` +
          `<p>已写 <code>${haltFile}</code> —— 全系统停止下单,包括 chain-watch。</p>` +
          `<p>本进程累计成交 $${filledTotal.toFixed(2)}。<b>已持仓的部分需要人工决定是否平仓</b>(NO 腿 ask 约 0.80,平仓成本高;也可能只是更正到 0.9x 而条款仍另有一期达标,先看数据再动)。</p>` +
          `<p>确认误报后删除 halt 文件才能恢复交易。</p>`
      );
      return;
    }

    if (decision.alert && Date.now() - lastAlertAt > 3600_000) {
      lastAlertAt = Date.now();
      await notify("⚠️ oregon-sniper:USDM 长时间读不到,已持续停火", `<p>${decision.why}</p><p>${usdm.reason}</p>`);
    }

    if (decision.closed) {
      flushIdle();
      emit({ kind: "market-closed", closed: m?.closed, acceptingOrders: m?.acceptingOrders, filledTotal });
      await notifyTerminal(
        "closed",
        `🏁 oregon-sniper 收工:市场已关闭,累计成交 $${filledTotal.toFixed(2)}`,
        `<p>closed=${m?.closed} acceptingOrders=${m?.acceptingOrders} —— 大概率是 7 天 holding 期满已 finalize。</p>` +
          `<p>累计成交 <b>$${filledTotal.toFixed(2)}</b>,明细见 ${OUT}</p>`
      );
      return;
    }

    if (!decision.fire) {
      // 不开火的轮次只在**状态变化**时落行:11 小时 / 20s = 约 2000 轮,逐轮
      // 落行会把真正要看的那几行(成交、撤回、市场关闭)埋掉。repeats 保留
      // "这个状态持续了多少轮"这一信息,不是简单丢弃。
      if (decision.why !== lastIdleWhy) {
        flushIdle();
        lastIdleWhy = decision.why;
        emit({ kind: "idle", round, why: decision.why, bestAsk: book?.bestAsk ?? null, depthUsd: book?.depthUsd ?? 0 });
      } else {
        idleRepeats += 1;
      }
      if (ONCE) break;
      await sleep(POLL_MS);
      continue;
    }
    flushIdle(); // 要开火了:先把 idle 段结掉,别让它跨过成交行继续累加

    // 分层:按**本轮 ask** 重设三个单机会规模闸(总敞口不动,见 budgetForAsk)。
    const cap = applyCaps(book!.bestAsk!);
    if (cap.tier) {
      emit({
        kind: "tier",
        round,
        ask: book!.bestAsk,
        tier: `ask≤${cap.tier.maxAsk}`,
        budget: cap.usd,
        fallback: BUDGET,
        maxOrderUsd: execConfig().maxOrderUsd,
        maxOrderRaised: cap.pins.maxOrderRaised,
        totalMaxUsd: execConfig().totalMaxUsd,
      });
    }

    const attempt = await fireOnce(m!, book!.bestAsk!, `轮#${round}${cap.tier ? ` [tier≤${cap.tier.maxAsk}→$${cap.usd}]` : ""}`);
    if (attempt.status === "filled" || attempt.status === "partial") {
      filledTotal += attempt.filledUsd ?? 0;
      exhaustedStreak = 0;
      emit({ kind: "progress", filledTotal, budget: cap.usd, remainingDepthUsd: book!.depthUsd });
      await notify(
        `✅ oregon-sniper 成交 $${(attempt.filledUsd ?? 0).toFixed(2)} @${attempt.avgPrice ?? "?"}(累计 $${filledTotal.toFixed(2)})`,
        `<p>本笔:$${(attempt.filledUsd ?? 0).toFixed(2)} @均价 ${attempt.avgPrice ?? "—"}(限价 ${attempt.limitPrice ?? "—"})</p>` +
          `<p>累计成交 <b>$${filledTotal.toFixed(2)}</b> / 预算 $${BUDGET}</p>` +
          `<p>结算后毛利约 $${(filledTotal / (attempt.avgPrice || 0.8) - filledTotal).toFixed(2)}(按本笔均价粗算)</p>`
      );
    } else if (isExhausted(attempt.reason)) {
      // 额度或深度耗尽:不是错误,是"这一轮没肉了"。降频到 5 倍轮询间隔,
      // 既不刷屏也不空转 —— 卖家补货 / 次日额度重置都可能让它重新有肉。
      exhaustedStreak += 1;
      emit({ kind: "exhausted", round, streak: exhaustedStreak, reason: attempt.reason, filledTotal });
      if (ONCE) break;
      await sleep(POLL_MS * 5);
      continue;
    }

    if (ONCE) break;
    await sleep(POLL_MS);
  }

  flushIdle();
  emit({ kind: "done", rounds: round, filledTotal, ranMs: Date.now() - startedAt });
  // 收尾邮件同上线邮件:cron 模式下每轮都"收尾"一次,一天 144 封总账信,而
  // 每一封的内容都是"这 5 秒里发生了什么"。成交邮件已经逐笔送达,总账看 ledger。
  if (!ONCE) {
    await notify(
      `📊 oregon-sniper 收尾,累计成交 $${filledTotal.toFixed(2)}`,
      `<p>运行 ${((Date.now() - startedAt) / 3600_000).toFixed(1)} 小时 / ${round} 轮。</p>` +
        `<p>累计成交 <b>$${filledTotal.toFixed(2)}</b>,明细见 ${OUT}</p>` +
        `<p>窗口未结束(死线 08-13 finalize)可直接重跑本脚本继续吃。</p>`
    );
  }
}

// 直接执行时才跑 main;被测试 import 时只拿纯函数(否则 `npx tsx --test`
// 会在 import 的瞬间起一个 11 小时的守盘循环)。
if (require.main === module) {
  main().catch((err) => {
    console.error(`[oregon-sniper] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
