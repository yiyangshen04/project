import type { GammaMarket } from "../types";
import type { PolymarketClient } from "./client";
import { guardHeadJump } from "./headGuard";

/**
 * Incremental on-chain event sweep for the dispute-flow class.
 *
 * Snapshot-style Gamma scans structurally miss the ~2h re-proposal window
 * (and any Gamma indexing lag): on 2026-07-04, 2 of 3 QuestionReset events
 * in a 24h backscan belonged to markets absent from that day's whole scan
 * surface. The chain is ground truth — QuestionReset fires the moment a
 * first dispute resets the adapter, AncillaryDataUpdated the moment an
 * official posts context. Sweeping the window since the previous scan makes
 * the manual-refresh workflow event-driven: nothing that happened between
 * two refreshes goes unseen.
 *
 * Free-RPC constraints (measured): drpc allows arbitrary lookback at ~100
 * blocks/window (~330ms each); publicnode only serves windows hugging the
 * chain head (≤127 blocks) — kept as a best-effort fallback. The sweep is
 * capped at MAX_LOOKBACK_BLOCKS; anything older is either resolved already
 * or still current-status `disputed` and thus covered by the Gamma backstop.
 */

// keccak256("QuestionReset(bytes32)") — emitted by UmaCtfAdapter._reset on
// every first dispute (and DVM ignore-price re-resets).
const TOPIC_QUESTION_RESET =
  "0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f";
// keccak256("AncillaryDataUpdated(bytes32,address,bytes)") — BulletinBoard
// official context postings (V3.0+ adapters only; V2 stores without emitting).
const TOPIC_ANCILLARY_UPDATED =
  "0x0059e11815211969c0c4aaf3f498b52b6c2f2d14f286275d0862d70de22a836b";

/** Adapters with open markets as of 2026-07 (from the s7 census + research):
 * V4 regular, V4 neg-risk, V3.1 regular, V3.1 neg-risk, V2 (one market).
 * The scanner additionally unions in every `resolvedBy` seen in the current
 * market pool, so a new adapter deployment degrades to "caught on the next
 * scan" instead of silence. */
export const KNOWN_ADAPTERS = [
  "0x65070be91477460d8a7aeeb94ef92fe056c2f2a7",
  "0x69c47de9d4d3dad79590d61b9e05918e03775f24",
  "0x157ce2d672854c848c9b79c49a8cc6cc89176a49",
  "0x2f5e3684cb1f318ec51b00edba38d79ac2c0aa9d",
  "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74",
];

const WINDOW_BLOCKS = 100; // free-tier getLogs cap (drpc ~101, measured)
// Polygon block time measured 1.5000 s/block (5 independent samples spanning
// 2026-06→08; the earlier ~2s figure predates the switch). The old constants
// therefore covered only 2.25 days / 18 h — a 25% short lookback that silently
// truncated catch-up after any outage longer than that.
const MAX_LOOKBACK_BLOCKS = 172_800; // ~3 days of Polygon blocks (~1.5s each, measured 2026-08)
const DEFAULT_LOOKBACK_BLOCKS = 57_600; // first run / lost cursor: ~1 day
const SWEEP_CONCURRENCY = 4;
const KV_CURSOR_KEY = "onchain_events_last_block";
// Scan/advance only to a confirmed depth. A getLogs window served by a lagging
// RPC replica (or a shallow reorg) would otherwise return "success but missing
// tail blocks" while the cursor sails past them — a permanent silent miss.
const CONFIRMATIONS = 25;

function rpcUrls(): string[] {
  const configured = process.env.ONCHAIN_RPC_URLS?.trim();
  if (configured) {
    return configured
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  }
  return [
    "https://polygon.drpc.org",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
  ];
}

interface LogEntry {
  address: string;
  topics: string[];
  blockNumber: string;
}

async function rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  return rpcRequestVia(rpcUrls(), method, params);
}

async function rpcRequestVia<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (const rpc of urls) {
    try {
      // AbortSignal.timeout covers the body read too — a plain
      // controller+clearTimeout fires as soon as headers arrive, so a
      // slow-drip response could hang res.json() up to undici's ~300s default.
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        result?: T;
        error?: { message?: string };
      };
      if (json.error || json.result === undefined) {
        throw new Error(json.error?.message ?? `empty ${method} result`);
      }
      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`all RPCs failed for ${method}`);
}

export interface OnchainDiscoveredMarket {
  question: string;
  slug: string;
  conditionId: string;
  umaResolutionStatus: string | null;
  /** How this market surfaced: reset event, official context posting, or both. */
  via: Array<"reset" | "context">;
}

export interface OnchainEventsSummary {
  fromBlock: number;
  toBlock: number;
  /** QuestionReset events in the window (first disputes + DVM re-resets). */
  resetCount: number;
  /** AncillaryDataUpdated events in the window (official context postings). */
  contextUpdateCount: number;
  /** Event questionIDs already covered by the current market pool. */
  knownHits: number;
  /** Markets the events surfaced that the Gamma pipeline did NOT have. */
  discovered: OnchainDiscoveredMarket[];
  /** Event questionIDs we could not map to a Gamma market (e.g. neg-risk
   * request IDs Gamma can't filter by). Kept visible rather than dropped. */
  unmatchedQuestionIds: string[];
  /** True when some windows failed — the cursor only advances past the
   * blocks that were actually swept, so nothing is silently skipped. */
  incomplete: boolean;
}

interface SweepDeps {
  getCursor: () => string | null;
  setCursor: (value: string) => void;
}

function defaultDeps(): SweepDeps {
  // localDb is loaded lazily so environments without node:sqlite (or with a
  // read-only FS) degrade to a fixed lookback instead of failing the sweep.
  return {
    getCursor: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return (require("../localDb") as typeof import("../localDb")).getKvState(
          KV_CURSOR_KEY
        );
      } catch {
        return null;
      }
    },
    setCursor: (value: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require("../localDb") as typeof import("../localDb")).setKvState(
          KV_CURSOR_KEY,
          value
        );
      } catch {
        // best-effort — next run falls back to DEFAULT_LOOKBACK_BLOCKS
      }
    },
  };
}

/**
 * Sweep QuestionReset + AncillaryDataUpdated since the last recorded block,
 * map event questionIDs back to Gamma markets, and return the ones the
 * current pipeline didn't already have.
 *
 * @param knownQuestionIds lowercase set of questionID AND negRiskRequestID
 *   values for every market already in the pool.
 * @param extraAdapters additional adapter addresses seen in the pool
 *   (unioned with KNOWN_ADAPTERS).
 */
export async function sweepDisputeEvents(
  client: PolymarketClient,
  knownQuestionIds: Set<string>,
  extraAdapters: string[] = [],
  deps: SweepDeps = defaultDeps()
): Promise<{ summary: OnchainEventsSummary; markets: GammaMarket[] }> {
  const rawHead = Number(await rpcRequest<string>("eth_blockNumber", []));
  if (!Number.isFinite(rawHead) || rawHead <= 0) {
    throw new Error(`bad eth_blockNumber result: ${rawHead}`);
  }

  const cursorRaw = deps.getCursor();
  const cursor = cursorRaw != null ? Number(cursorRaw) : NaN;

  // 头块守卫(2026-07-19 审查 §4,与 chain-watch 主循环共享 headGuard):
  // 多链网关误路由的假高头会经 setCursor 毒化 kv 游标,此后每轮 "no new
  // blocks" 静默死亡;假低头则静默空扫。chain-watch 侧同款 bug 已修,这里
  // 原先只有 isFinite && >0。
  await guardHeadJump({
    rawHead,
    lastCursor: Number.isFinite(cursor) ? cursor : 0,
    crossCheckHead: async () =>
      Number(await rpcRequestVia<string>([...rpcUrls()].reverse(), "eth_blockNumber", [])),
    tag: "onchain-events",
  });

  // Scan/advance the cursor only up to a confirmed depth (see CONFIRMATIONS).
  const head = rawHead - CONFIRMATIONS;

  const from = Number.isFinite(cursor)
    ? Math.max(cursor + 1, head - MAX_LOOKBACK_BLOCKS)
    : head - DEFAULT_LOOKBACK_BLOCKS;

  const adapters = [
    ...new Set(
      [...KNOWN_ADAPTERS, ...extraAdapters]
        .map((a) => a.toLowerCase())
        .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
    ),
  ];

  // Build ~100-block windows and fetch logs for all adapters + both topics
  // in one call per window (address array + topic0 OR-array).
  const windows: Array<{ from: number; to: number }> = [];
  for (let start = from; start <= head; start += WINDOW_BLOCKS) {
    windows.push({ from: start, to: Math.min(start + WINDOW_BLOCKS - 1, head) });
  }

  const logs: LogEntry[] = [];
  const failedWindows: number[] = [];
  for (let i = 0; i < windows.length; i += SWEEP_CONCURRENCY) {
    const batch = windows.slice(i, i + SWEEP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (w, idx) => {
        try {
          return await rpcRequest<LogEntry[]>("eth_getLogs", [
            {
              fromBlock: `0x${w.from.toString(16)}`,
              toBlock: `0x${w.to.toString(16)}`,
              address: adapters,
              topics: [[TOPIC_QUESTION_RESET, TOPIC_ANCILLARY_UPDATED]],
            },
          ]);
        } catch {
          failedWindows.push(i + idx);
          return [] as LogEntry[];
        }
      })
    );
    for (const page of results) logs.push(...page);
  }

  // Advance the cursor only through the contiguous prefix of successful
  // windows — a failed window mid-sweep must be retried next time.
  const firstFailed = failedWindows.length > 0 ? Math.min(...failedWindows) : -1;
  const sweptThrough =
    firstFailed === -1
      ? head
      : firstFailed === 0
        ? from - 1
        : windows[firstFailed - 1].to;
  if (sweptThrough >= from) {
    deps.setCursor(String(sweptThrough));
  }

  let resetCount = 0;
  let contextUpdateCount = 0;
  const eventQids = new Map<string, Set<"reset" | "context">>();
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    const qid = log.topics?.[1]?.toLowerCase();
    if (!qid) continue;
    const kind: "reset" | "context" | null =
      topic0 === TOPIC_QUESTION_RESET
        ? "reset"
        : topic0 === TOPIC_ANCILLARY_UPDATED
          ? "context"
          : null;
    if (!kind) continue;
    if (kind === "reset") resetCount += 1;
    else contextUpdateCount += 1;
    if (!eventQids.has(qid)) eventQids.set(qid, new Set());
    eventQids.get(qid)!.add(kind);
  }

  const unknownQids = [...eventQids.keys()].filter(
    (qid) => !knownQuestionIds.has(qid)
  );
  const knownHits = eventQids.size - unknownQids.length;

  // Map unknown questionIDs back to Gamma markets. `question_ids` matches the
  // regular questionID field; neg-risk request IDs won't match and stay in
  // unmatchedQuestionIds (visible, not dropped).
  const { markets, unmatched } = await fetchMarketsByQuestionIds(
    client,
    unknownQids
  );

  const discovered: OnchainDiscoveredMarket[] = markets.map((m) => {
    const qid = m.questionID?.toLowerCase() ?? "";
    const via = [...(eventQids.get(qid) ?? [])];
    return {
      question: m.question,
      slug: m.slug,
      conditionId: m.conditionId,
      umaResolutionStatus: m.umaResolutionStatus ?? null,
      via: via.length > 0 ? via : ["reset"],
    };
  });

  return {
    summary: {
      fromBlock: from,
      toBlock: head,
      resetCount,
      contextUpdateCount,
      knownHits,
      discovered,
      unmatchedQuestionIds: unmatched,
      incomplete: failedWindows.length > 0,
    },
    markets,
  };
}

async function fetchMarketsByQuestionIds(
  client: PolymarketClient,
  qids: string[]
): Promise<{ markets: GammaMarket[]; unmatched: string[] }> {
  if (qids.length === 0) return { markets: [], unmatched: [] };
  const markets = await client.fetchMarketsByQuestionIds(qids);
  const matched = new Set(
    markets.map((m) => m.questionID?.toLowerCase()).filter(Boolean)
  );
  return {
    markets,
    unmatched: qids.filter((q) => !matched.has(q)),
  };
}
