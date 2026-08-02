/**
 * 家族值守探视器(2026-08-02)。日历上写死的事件(CSU 8-05 飓风季预报、首个
 * 飓风命名、NFP/CPI 等)在官方发文前后是已知的高价值窗口,但 chain-watch 的
 * preArm 只对"官方发过预告模板文本"的市场自动预埋 —— 对这类"现实世界数据
 * 发布驱动"的窗口无能为力。这个脚本是人工值守用的一屏现状:一条命令看清
 * 某个家族此刻的盘口、深度、费率、UMA 状态,决定要不要盯。
 *
 * 用法:
 *   npx tsx scripts/watch-family.ts --event 773492        # 按 Gamma event id
 *   npx tsx scripts/watch-family.ts --slug atlantic-named-storms-forecast-for-2026-20260730135452992
 *   npx tsx scripts/watch-family.ts --event 773492 --json
 *
 * 8 月日历(来自 08-01/08-02 复盘):
 *   · 8-05  CSU 飓风季预报 → event 773492 "Atlantic Named Storms forecast for 2026?"
 *           三档 ≤7 / 8 / ≥9,negRisk=true,冷盘(单档几十美元量级)
 *   · 首个飓风获得命名 → 同时引爆命名/计数/登陆三个家族
 *   · NOAA 季中展望(8 月上旬)、NFP 8-7、CPI ~8-12
 *
 * 只读:不下单、不写任何状态。
 */
import { CLOB_API, GAMMA_API } from "../lib/polymarket/config";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const eventId = argv.includes("--event") ? argv[argv.indexOf("--event") + 1] : null;
const slug = argv.includes("--slug") ? argv[argv.indexOf("--slug") + 1] : null;

if (!eventId && !slug) {
  console.error("用法: --event <gammaEventId> | --slug <eventSlug>  [--json]");
  process.exit(2);
}

interface GammaMarket {
  question: string;
  conditionId: string;
  slug?: string;
  closed?: boolean;
  outcomes?: string;
  clobTokenIds?: string;
  umaResolutionStatus?: string;
  volume?: string;
  liquidity?: string;
  negRisk?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; rebateRate?: number };
  endDate?: string;
}
interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  closed?: boolean;
  negRisk?: boolean;
  markets?: GammaMarket[];
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

interface BookSide {
  price: string;
  size: string;
}

/** CLOB /book 是全镜像(NO ask ≡ 1−YES bid,size 一致)—— 空 asks 意味着该方向
 * 任何价位都没有 taker 对手盘,不是"接口没返回"。这个区分是 2026-08-01 飓风家族
 * 复盘的核心结论,值守时必须一眼看到。 */
async function bookFor(tokenId: string): Promise<{ asks: BookSide[]; bids: BookSide[] } | null> {
  return getJson(`${CLOB_API}/book?token_id=${tokenId}`);
}

function depthUsd(asks: BookSide[], within = 0.05): number {
  const parsed = asks
    .map((a) => ({ p: Number(a.price), s: Number(a.size) }))
    .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.s) && x.s > 0)
    .sort((a, b) => a.p - b.p);
  if (parsed.length === 0) return 0;
  const ceil = parsed[0].p + within;
  return parsed.filter((x) => x.p <= ceil).reduce((s, x) => s + x.p * x.s, 0);
}

async function main(): Promise<void> {
  const url = eventId ? `${GAMMA_API}/events?id=${eventId}` : `${GAMMA_API}/events?slug=${slug}`;
  const arr = await getJson<GammaEvent[] | GammaEvent>(url);
  const ev = Array.isArray(arr) ? arr[0] : arr;
  if (!ev) {
    console.error("未找到该 event(注意:已关闭的事件要用 Gamma 的 closed 查询口径)");
    process.exit(1);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const m of ev.markets ?? []) {
    let tokenIds: string[] = [];
    let outcomes: string[] = [];
    try {
      tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
      outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
    } catch {
      // 字段形态异常时留空,下面按 "?" 展示
    }
    const legs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < tokenIds.length; i += 1) {
      const b = await bookFor(tokenIds[i]);
      const asks = b?.asks ?? [];
      const bids = b?.bids ?? [];
      const sortedAsks = asks
        .map((a) => Number(a.price))
        .filter(Number.isFinite)
        .sort((x, y) => x - y);
      legs.push({
        outcome: outcomes[i] ?? `#${i}`,
        tokenId: tokenIds[i],
        bestAsk: sortedAsks[0] ?? null,
        bookEmpty: b != null && asks.length === 0,
        depthUsd: Math.round(depthUsd(asks) * 100) / 100,
        askLevels: asks.length,
        bidLevels: bids.length,
      });
    }
    rows.push({
      question: m.question,
      conditionId: m.conditionId,
      closed: m.closed === true,
      uma: m.umaResolutionStatus ?? null,
      volume: Number(m.volume ?? 0),
      liquidity: Number(m.liquidity ?? 0),
      negRisk: m.negRisk === true,
      feesEnabled: m.feesEnabled ?? null,
      feeRate: m.feeSchedule?.rate ?? null,
      rebateRate: m.feeSchedule?.rebateRate ?? null,
      endDate: m.endDate ?? null,
      legs,
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ event: { id: ev.id, title: ev.title, slug: ev.slug, negRisk: ev.negRisk }, markets: rows }, null, 1));
    return;
  }

  console.log(`\n=== ${ev.title} ===`);
  console.log(`event ${ev.id} · slug ${ev.slug} · negRisk=${ev.negRisk === true} · closed=${ev.closed === true}`);
  console.log(`市场 ${rows.length} 个\n`);
  for (const r of rows) {
    const legs = r.legs as Array<Record<string, unknown>>;
    console.log(`── ${r.question}`);
    console.log(
      `   closed=${r.closed} uma=${r.uma ?? "-"} vol=$${Math.round(Number(r.volume))} liq=$${Math.round(Number(r.liquidity))}` +
        ` fee=${r.feesEnabled === false ? "免费" : `${r.feeRate ?? "?"}(返 ${r.rebateRate ?? "?"})`}`
    );
    for (const l of legs) {
      const empty = l.bookEmpty === true;
      console.log(
        `     ${String(l.outcome).padEnd(6)} ask=${l.bestAsk ?? "—"}` +
          ` 近档深度 $${l.depthUsd}` +
          ` (ask档 ${l.askLevels} / bid档 ${l.bidLevels})` +
          `${empty ? "  ⚠ 空盘:taker 任何价位不可成交,唯 maker 可吃" : ""}`
      );
    }
    console.log("");
  }
  console.log(
    `提示:本脚本只看盘口,不判方向。真正的方向信号来自 chain-watch 的官方澄清\n` +
      `监听 —— 值守当天保持 cron 正常即可,这里只是让你决定要不要人工在场。\n`
  );
}

main().catch((err) => {
  console.error(`[watch-family] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
