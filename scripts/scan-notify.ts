/**
 * 无头扫描 + 邮件通知 CLI — cron 入口。
 *
 * 用法:
 *   npm run scan:notify        (等价于 npx tsx scripts/scan-notify.ts)
 *
 * 流程:
 *   1. 探测 Gamma API 可达性(10s 超时);
 *      - 可达   → 完整模式 runScan(DEFAULT_SCAN_CONFIG)
 *      - 不可达 → 打印日志后退出(纯链上降级模式尚未接入,见 runChainOnlyMode)
 *   2. 从 opportunities 里筛"值得通知的机会"(见 isNotifiable);
 *   3. 用 data/notify-state.json 去重防轰炸:只有新 tokenId、或 decision /
 *      officialContext.stance 变化的机会才进入本次邮件;
 *   4. 有新内容 → 发 HTML 邮件;全无新内容 → 不发,日志说明;
 *   5. 结尾打印一行 JSON 摘要,方便 cron 日志 grep。
 *
 * 退出码: 0 正常(含"无新内容不发邮件"),1 异常,2 Gamma 不可达且降级模式未接入。
 */
import fs from "node:fs";
import path from "node:path";
import { runScan, takerFeeRateOf } from "../lib/polymarket/scanner";
import { DEFAULT_SCAN_CONFIG } from "../lib/polymarket/config";
import { PolymarketClient } from "../lib/polymarket/client";
import { takerFeePct } from "../lib/polymarket/scoring";
import type { Opportunity, ScanResponse, ScanRun } from "../lib/types";
import { renderOpportunitiesEmail, sendMail } from "./mailer";
import { writeFileAtomic } from "../lib/fsAtomic";
import { isDirectionalStance } from "../lib/virtualTags";

/** 规则 a(无官方文本背书的纯争议腿)的价格地板。bt3:0.90-0.995 尾价 carry
 * 档 n=107 胜率 100%/+3.1%,是有据的;0.55-0.90 的无方向争议腿零回测样本。
 * 注意这不是全局价格窗 —— 带官方文本方向的机会走规则 c,不受此约束
 * (肥尾的入场价恰在 0.16-0.50 低位)。 */
const DISPUTED_NOTIFY_MIN_PRICE = Number(process.env.DISPUTED_NOTIFY_MIN_PRICE) || 0.9;

/** 纯 decision 档位抖动的重发冷却(stance/via/confidence 未变时生效)。 */
const NOTIFY_COOLDOWN_MS = Number(process.env.NOTIFY_COOLDOWN_MS) || 12 * 3600_000;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(PROJECT_ROOT, "data", "notify-state.json");

/** Reserved notify-state key (not a tokenId) tracking whether we last alerted
 * on a coverage degradation, so the degraded email is edge-triggered (once per
 * episode) instead of every 30-minute tick. */
const COVERAGE_KEY = "__coverage__";
const GAMMA_PROBE_URL = "https://gamma-api.polymarket.com/markets?limit=1";
const GAMMA_PROBE_TIMEOUT_MS = 10_000;

// ── Gamma 可达性探测 ──

async function probeGamma(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(GAMMA_PROBE_URL, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── 降级模式(未实现,仅接入点)──

/**
 * TODO(chain-only): 纯链上降级模式 — Gamma 不可达时,不经 Gamma,直接从链上
 * (UMA CTF Adapter 事件 / CLOB)重建争议市场机会清单,返回与完整模式同形的
 * ScanResponse,之后复用下面 main() 里同一套筛选/去重/邮件流程。
 * 具体实现稍后接入;当前版本不要调用。
 */
async function runChainOnlyMode(): Promise<ScanResponse> {
  throw new Error("chain-only degraded mode 尚未实现(接入点占位)");
}

// ── 筛选:值得通知的机会 ──

function isNotifiable(o: Opportunity): boolean {
  const reasons = o.decisionReasons ?? [];
  // b. 官方分歧形态 — 最高优先,无条件通知
  if (reasons.includes("official_divergence_play")) return true;
  // a. UMA 状态为 disputed 且 decision 为 actionable,且净收益 ≥3%(2026-07-08
  // 收窄:无官方文本背书的纯争议领先腿,历史判卷显示 净收益 2-3% 档恰是期望
  // 最差的机会面——通知时买价普遍 >0.95、盈亏比 1:20+;3% 地板恰好留下判卷
  // 认可的 full lid 型有肉机会,挡掉 @0.972 型肉薄通知。带 via=text 官方文本
  // 的机会不受影响,照走规则 c。)
  //
  // 2026-08-02 复盘收窄:规则 a 原本完全不看方向、也没有价格天花板,成了
  // stance=null / price_fallback / dispute_notice 三档共 21/28 条通知的万能
  // 后门。实测后果:近 4 周 21 个市场里 7 个把正反两条腿都发了通知;还发出过
  // net80.8%(入场价 ≈0.55,本质掷硬币)这种通知 —— 而这个 cohort 的 PnL 回测
  // 样本量是 0。13 天 39 封邮件里唯一值钱的那封被埋在 38 封噪音里。
  // 两条约束:
  //   ① 代码自己列为"无方向"的 stance 不许走 actionable 通知(虚拟标签里
  //      DIRECTIONLESS_STANCES 已明确,规则 a 却绕过了它);
  //   ② 补一个价格地板:尾价 carry(bt3 里 0.90-0.995 档 n=107 胜率 100%)
  //      是有据的;0.55-0.90 的无方向争议腿没有任何回测支撑,降级为观察。
  //      带官方文本方向的机会不受此约束 —— 它们走规则 c(肥尾入场价恰在低位)。
  const uma = (o.umaResolutionStatus ?? "").trim().toLowerCase();
  if (uma === "disputed" && o.decision === "actionable" && (o.netReturnPct ?? 0) >= 0.03) {
    const stance = o.officialContext?.stance ?? null;
    const directional = stance != null && isDirectionalStance(stance);
    const tailCarry = o.price >= DISPUTED_NOTIFY_MIN_PRICE;
    if (directional || tailCarry) return true;
    return false;
  }
  // c. 官方方向背书。仅限官方真实文本(via=text):price_fallback 是无文本时按
  // 价格推断的方向,官方并未背书,不配触发"官方方向"邮件(32/32 战绩只属于官方
  // 明确文本口径)。此处不再要求 decision!==rejected:一个官方已背书、但因盘口
  // 薄(insufficient_depth / excessive_slippage / net_return_below_threshold)
  // 被量化硬拒的领先腿,恰恰是最该知会的机会——邮件里照常显示 decision 供人工
  // 判断能否小额吃进。refund_clause / official_contradicts_side 的市场经
  // officialContext 修复后已不再携带 official_direction_backed,天然排除在外。
  // 排除 divergenceLeg:被拒的落后腿只配走规则 b 的分歧闸门(要求 high 置信),
  // 否则中置信 leans 文本会让 0.1x 的 trailing 腿以"官方背书"名义漏进邮件。
  if (
    reasons.includes("official_direction_backed") &&
    o.officialContext?.via === "text" &&
    o.divergenceLeg !== true
  ) {
    return true;
  }
  return false;
}

// ── 去重状态(data/notify-state.json)──

interface NotifyStateEntry {
  lastDecision: string;
  lastStance: string | null;
  /** officialContext.via at last notify. Included in the change test so a
   * price_fallback → official-text (via=text) upgrade re-notifies even when the
   * stance string is unchanged — that upgrade is the highest-value transition
   * (the 32/32 official-text cohort) and must not be silently suppressed. */
  lastVia?: string | null;
  /** officialContext.confidence at last notify — a medium→high upgrade on the
   * same stance is also worth re-surfacing. */
  lastConfidence?: string | null;
  notifiedAt: string;
}

type NotifyState = Record<string, NotifyStateEntry>;

function loadState(): NotifyState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as NotifyState;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[scan-notify] 状态文件 ${STATE_FILE} 读取/解析失败,按空状态处理:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return {};
}

function saveState(state: NotifyState): void {
  // Atomic write: a crash mid-write must not leave a truncated JSON that the
  // next run parses as empty and then re-emails every already-notified market.
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/** 折叠 decision 到通知档位:rejected 与 observe 同档。规则 c 放行 rejected 后,
 * 盘口在深度/滑点阈值附近徘徊会让 decision 在 rejected↔observe 间反复翻转,
 * 每次翻转都算"变化"会在 48-72h 争议期里积累几十封重复邮件;真正值得重发的
 * 只有跨 actionable 边界的变化。 */
function decisionTier(decision: string): string {
  return decision === "actionable" ? "actionable" : "sub_actionable";
}

const CONFIDENCE_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * 新 tokenId,或相对上次通知发生了值得重发的变化:
 * - decision 跨 actionable 边界(双向:进场/离场都值得知道),但 stance/via/
 *   confidence 均未变的纯档位抖动受 NOTIFY_COOLDOWN_MS(默认 12h)冷却约束
 *   —— 2026-08-02 复盘实测同一市场 8.6 天发出 11 封逐字相同的邮件;
 * - stance 字符串变化(双向:方向翻转是最重要的信号);
 * - via / confidence 仅在**升级**时触发(price_fallback→text、置信度上升)。
 *   降级多半是 RPC 瞬断导致官方文本暂时读不到(text→price_fallback 回落),
 *   双向比较会在瞬断恢复后再触发一次,成对发出无信息量的重复邮件;
 * - 旧版状态条目没有 lastVia/lastConfidence 字段("lastVia" in prev 为 false),
 *   跳过升级比较,避免升级部署后第一轮把所有已通知机会重发一遍。
 */
function isNewOrChanged(state: NotifyState, o: Opportunity): boolean {
  const prev = state[o.tokenId];
  if (!prev) return true;
  // 实质变化(stance/via/confidence)优先判定,不受冷却约束 —— 官方文本升级
  // 是最高价值的转换,任何时候都要立刻发。
  const stanceChanged = (prev.lastStance ?? null) !== (o.officialContext?.stance ?? null);
  const viaUpgraded = o.officialContext?.via === "text" && prev.lastVia !== "text";
  const confUpgraded =
    (CONFIDENCE_RANK[o.officialContext?.confidence ?? "none"] ?? 0) >
    (CONFIDENCE_RANK[prev.lastConfidence ?? "none"] ?? 0);
  if (stanceChanged) return true;
  if ("lastVia" in prev && (viaUpgraded || confUpgraded)) return true;
  // decision 档位翻转的冷却(2026-08-02 复盘):isNewOrChanged 只把
  // rejected↔observe 折叠掉了,actionable↔rejected 的抖动照样触发重发 ——
  // 而规则 c 放行 rejected,于是盘口深度/滑点在阈值附近来回摆的官方背书腿会
  // 反复重发。实测:"Iran agrees to end enrichment" 8.6 天发了 11 封逐字相同
  // 的邮件;"U.S. anti-cartel" 4 小时内 4 封。stance/via/confidence 都没变的
  // 纯档位抖动,12h 内不再重发。
  if (decisionTier(prev.lastDecision) !== decisionTier(o.decision)) {
    const since = Date.parse(prev.notifiedAt ?? "");
    if (!Number.isFinite(since) || Date.now() - since >= NOTIFY_COOLDOWN_MS) return true;
    return false;
  }
  return false;
}

// ── 主流程 ──

async function main(): Promise<void> {
  console.log(`[scan-notify] ${new Date().toISOString()} 启动,探测 Gamma 可达性…`);
  const gammaOk = await probeGamma();

  if (!gammaOk) {
    console.error(
      `[scan-notify] Gamma API 不可达(${GAMMA_PROBE_URL},超时 ${GAMMA_PROBE_TIMEOUT_MS / 1000}s)。`
    );
    console.error(
      "[scan-notify] 纯链上降级模式尚未接入(见 runChainOnlyMode 接入点),本次退出。"
    );
    // TODO(chain-only): 降级模式接入后,把上面两行 + exit 换成:
    //   const response = await runChainOnlyMode();
    //   mode = "chain_only"; 然后走下方同一套筛选/去重/邮件流程。
    process.exit(2);
  }

  const mode = "full";
  console.log("[scan-notify] Gamma 可达,进入完整模式扫描…");
  const response = await runScan(DEFAULT_SCAN_CONFIG);
  const { scan, opportunities } = response;
  console.log(
    `[scan-notify] 扫描完成 scanId=${scan.scanId},共 ${opportunities.length} 个机会` +
      `(actionable=${scan.actionableCount}, observe=${scan.observeCount}, rejected=${scan.rejectedCount})`
  );

  // 机会历史落库(2026-08-02 复盘):persistScanResult 一直只被 Web UI 路由
  // 调用,cron 路径从未调用 —— 生产 sqlite 的 scan_runs/opportunities/
  // odds_snapshots 三表至今 0 行,每轮 185~192 个机会打完日志就扔,导致既无法
  // 做校准也无法回溯"错过了什么"。惰性 require + try/catch:保持 scan-notify
  // "无 sqlite 也能跑"的既有承诺,落库失败绝不阻塞扫描与告警。
  // 刻意排在任何网络发送之前(2026-08-02 审计 finding 7):此前落库排在
  // sendMail 之后且 sendMail 无 try/catch,SMTP 授权码过期或代理瞬断会让 main
  // 直接 reject,当轮 185~192 个机会一条都不落库 —— 正好废掉本次加落库的全部
  // 目的。落库是纯本地 sqlite 写、自带兜底,发信失败不得连累落库。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require("../lib/localDb") as typeof import("../lib/localDb");
    db.persistScanResult(scan, opportunities);
  } catch (err) {
    console.warn(
      `[scan-notify] 机会落库失败(不阻塞扫描): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const notifiable = opportunities.filter(isNotifiable);
  const state = loadState();
  const toNotify = notifiable.filter((o) => isNewOrChanged(state, o));
  console.log(
    `[scan-notify] 符合通知条件 ${notifiable.length} 个,其中新增/状态变化 ${toNotify.length} 个。`
  );

  if (toNotify.length === 0) {
    console.log("[scan-notify] 无新内容(全部已通知过且 decision/stance/via 未变化),不发邮件。");
  } else {
    const email = renderOpportunitiesEmail(toNotify, scan);
    const { messageId } = await sendMail(email);
    console.log(`[scan-notify] 邮件已发送 messageId=${messageId},主题: ${email.subject}`);

    // 发送成功后才写回状态,发送失败则下次重试。
    const notifiedAt = new Date().toISOString();
    for (const o of toNotify) {
      state[o.tokenId] = {
        lastDecision: o.decision,
        lastStance: o.officialContext?.stance ?? null,
        lastVia: o.officialContext?.via ?? null,
        lastConfidence: o.officialContext?.confidence ?? null,
        notifiedAt,
      };
    }
    saveState(state);
  }

  // 覆盖降级告警(边沿触发,一次降级只发一封):争议普查页失败
  // (disputeCoverage.complete=false)或订单簿抓取失败(booksIncomplete)意味着本
  // 轮机会集可能缺失真实候选——不能静默显示"扫描正常"。
  await handleCoverageDegradation(scan, state);

  // I6 后半:结算 chain-watch 自动登记的虚拟持仓(30 分钟节奏,有 Gamma)。
  await resolveOpenPaperTrades();

  // cron 日志 grep 用的一行 JSON 摘要
  console.log(
    JSON.stringify({
      scanId: scan.scanId,
      opportunities: opportunities.length,
      notified: toNotify.length,
      coverageComplete: scan.disputeCoverage?.complete ?? null,
      booksIncomplete: scan.booksIncomplete ?? false,
      mode,
    })
  );
}

/** Edge-triggered coverage-degradation alert. Emails once when coverage goes
 * healthy→degraded and once on recovery, mirroring the heartbeat pattern so a
 * persistent degradation doesn't spam every 30-minute tick. */
async function handleCoverageDegradation(scan: ScanRun, state: NotifyState): Promise<void> {
  const degraded =
    scan.disputeCoverage?.complete === false || scan.booksIncomplete === true;
  const prevDegraded = state[COVERAGE_KEY]?.lastDecision === "degraded";
  const now = new Date().toISOString();

  if (degraded) {
    const reasonBits: string[] = [];
    if (scan.disputeCoverage?.complete === false) reasonBits.push("争议普查分页失败(complete=false)");
    if (scan.booksIncomplete === true) reasonBits.push("订单簿抓取失败(booksIncomplete)");
    const reason = reasonBits.join(" + ");
    console.warn(`[scan-notify] ⚠️ 覆盖降级:${reason} — 本轮机会集可能缺失真实候选。`);
    if (!prevDegraded) {
      // at-least-once:只有发信成功才把状态标为 degraded。发信失败时保持旧
      // 状态,下个 30 分钟 tick 重试——否则首封告警被 SMTP 抖动吞掉后,整个
      // 降级期(可能数天)就永久静默了,恰好重演 S1 修掉的反模式。
      try {
        await sendMail({
          subject: "[PredEdge] ⚠️ 扫描覆盖降级",
          html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><h3 style="color:#d97706;margin:0 0 8px">扫描覆盖降级</h3><p>scan <b>${scan.scanId}</b> 检测到:${reason}。</p><p>意味着本轮的机会/通知集<b>可能缺失真实候选</b>(区别于"没有机会")。请留意后续几轮是否恢复;持续降级建议检查 Gamma/CLOB 可达性与 RPC 限流。</p></div>`,
          text: `扫描覆盖降级 scan=${scan.scanId}:${reason}。本轮机会集可能缺失真实候选。`,
        });
        console.log("[scan-notify] 已发送覆盖降级告警邮件。");
        state[COVERAGE_KEY] = { lastDecision: "degraded", lastStance: null, notifiedAt: now };
        saveState(state);
      } catch (err) {
        console.error(`[scan-notify] 覆盖降级告警邮件发送失败(下轮重试):${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (prevDegraded) {
    console.log("[scan-notify] 覆盖已恢复正常。");
    state[COVERAGE_KEY] = { lastDecision: "ok", lastStance: null, notifiedAt: now };
    saveState(state);
  }
}

/**
 * I6 前瞻登记的结算侧:chain-watch 在 🟢 双确认时写入 paper_trades(status
 * open),这里每轮扫描后按 Gamma 结算结果关单——语义与 /api/trades/refresh
 * 完全一致(赢=每股 $1 − 费用/转账成本,输=-本金;closed 但价未定 = 结算窗口
 * 未完,跳过等下轮)。整体 best-effort:node:sqlite 不可用或 Gamma 抖动都不
 * 影响扫描主流程。
 */
async function resolveOpenPaperTrades(): Promise<void> {
  let db: typeof import("../lib/localDb");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = require("../lib/localDb") as typeof import("../lib/localDb");
  } catch {
    return;
  }
  try {
    const open = db.listOpenPaperTrades();
    if (open.length === 0) return;
    const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
    const conditionIds = Array.from(new Set(open.map((t) => t.conditionId).filter(Boolean)));
    const marketMap = await client.fetchMarketsByConditionIds(conditionIds);
    let resolved = 0;
    for (const trade of open) {
      const market = marketMap.get(trade.conditionId);
      if (!market || !market.closed) continue;
      let outcomes: string[] = [];
      let prices: number[] = [];
      try {
        outcomes = JSON.parse(market.outcomes).map(String);
        prices = JSON.parse(market.outcomePrices).map(Number);
      } catch {
        continue;
      }
      const winnerIdx = prices.findIndex((p) => Number.isFinite(p) && p >= 0.99);
      if (winnerIdx === -1) continue; // closed 但 UMA 结算未完 — 下轮再看
      const resolvedOutcome = outcomes[winnerIdx] ?? null;
      let status: "won" | "lost";
      let pnlUsd: number;
      if (resolvedOutcome === trade.outcomeBought) {
        status = "won";
        const avgPrice = trade.shares > 0 ? trade.usdAmount / trade.shares : 0;
        const feeCost =
          trade.usdAmount *
          (takerFeePct(avgPrice, takerFeeRateOf(market), DEFAULT_SCAN_CONFIG) +
            DEFAULT_SCAN_CONFIG.transferCostPct);
        pnlUsd = trade.shares - trade.usdAmount - feeCost;
      } else {
        status = "lost";
        pnlUsd = -trade.usdAmount;
      }
      const ok = db.updatePaperTradeResolution(trade.id, {
        status,
        resolvedOutcome,
        pnlUsd,
        pnlPct: trade.usdAmount > 0 ? pnlUsd / trade.usdAmount : 0,
        resolvedAt: new Date().toISOString(),
      });
      if (ok) resolved += 1;
    }
    if (resolved > 0) {
      console.log(`[scan-notify] paper trades 结算 ${resolved}/${open.length} 单。`);
    }
  } catch (err) {
    console.warn(
      `[scan-notify] paper trades 结算失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

main().catch((err) => {
  console.error("[scan-notify] 未捕获异常:", err);
  process.exit(1);
});
