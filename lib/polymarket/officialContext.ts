import type { GammaMarket, OfficialContext, Opportunity } from "../types";
import { adapterQuestionID, ethCall, isHex } from "./oracleState";
import { isDirectionalStance } from "../virtualTags";

export { isDirectionalStance };

/**
 * Official additional-context reader and stance classifier.
 *
 * Polymarket's official clarifications/rulings ("additional context") are NOT
 * exposed by the Gamma API — they live on-chain in the UMA CTF adapter and are
 * readable via `getQuestion(questionID)` (to recover the question creator) and
 * `getUpdates(questionID, owner)` (both arguments required; the single-arg
 * form returns nothing). The stance rules and the price fallback were
 * validated by the dispute-arb research (tmp/dispute-analysis/): markets where
 * officials wrote a directional context settled the official way 32/32.
 */

const SELECTORS = {
  getQuestion: "0x58c039cd",
  getUpdates: "0x555c56fc",
};

/** 官方 context 发布地址白名单(2026-07-14 官方行为研究,15 个月全量事件级
 * 考证):0x9143=2024-03→2026-05-21 主发布地址;0xf43d=2026-05-22 起接管;
 * 0xac99=2026-05-18 批量提前结算 ops。AncillaryDataUpdated 任何地址都能发
 * (updates 按 (questionID, owner) 分桶),链上已实测到掐着官方澄清前 4 秒
 * 抢发反向文本的对抗案例(Peng 案)与机器人测试文本——非白名单 owner 的
 * 事件与 creator 一律不得进入判读/交易路径。 */
export const OFFICIAL_CONTEXT_OWNERS: ReadonlySet<string> = new Set([
  "0xf43d55f3a8b7484ed4b6931f93cb6f9ef5dd369d",
  "0x91430cad2d3975766499717fa0d66a78d814e5c5",
  "0xac9930b2ae455a671b62de86876a7e8587825294",
]);

export function isOfficialContextOwner(addr: string | null | undefined): boolean {
  return !!addr && OFFICIAL_CONTEXT_OWNERS.has(addr.toLowerCase());
}

/** A disputed market priced at an extreme implies the leading side even when
 * the official text is absent or carries no parseable direction. */
const PRICE_FALLBACK_MIN = 0.9;

const EXCERPT_MAX_CHARS = 500;

export interface OfficialUpdate {
  timestamp: number;
  iso: string;
  text: string;
}

// ── ABI decode helpers (self-contained; oracleState keeps its own copies) ──

function wordAt(hex: string, byteOffset: number): string {
  return hex.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64);
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word || "0"}`);
}

function addressFromWord(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}

function addressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytesToUtf8(hexWithout0x: string): string {
  return Buffer.from(hexWithout0x, "hex").toString("utf8");
}

function decodeBytes(hex: string, byteOffset: number): { length: number; text: string } {
  const length = Number(uintWord(wordAt(hex, byteOffset)));
  const start = byteOffset + 32;
  const body = hex.slice(2 + start * 2, 2 + (start + length) * 2);
  return { length, text: bytesToUtf8(body) };
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Scan-based getQuestion decoder that also recovers the question creator.
 * Adapter versions differ in struct layout, so instead of assuming a fixed
 * word offset (like oracleState's decodeQuestion) this walks the candidate
 * offsets until it finds the dynamic bytes field whose payload looks like
 * ancillary data; the creator address sits in the word right before it.
 */
function decodeQuestionWithCreator(
  result: string
): { requestTimestamp: number; creator: string } | null {
  if (!result || result === "0x") return null;
  const byteLength = (result.length - 2) / 2;
  const base = Number(uintWord(wordAt(result, 0)));
  if (!Number.isFinite(base) || base < 0 || base + 32 > byteLength) {
    throw new Error("invalid getQuestion base offset");
  }
  const requestTimestamp = Number(uintWord(wordAt(result, base)));

  let offsetIndex: number | null = null;
  for (let i = 4; i < 32; i += 1) {
    const candidate = Number(uintWord(wordAt(result, base + i * 32)));
    if (candidate < 32 || candidate % 32 !== 0) continue;
    const lengthWordOffset = base + candidate;
    if (lengthWordOffset + 32 > byteLength) continue;
    const length = Number(uintWord(wordAt(result, lengthWordOffset)));
    if (length <= 0 || length > 20_000) continue;
    const bodyStart = 2 + (lengthWordOffset + 32) * 2;
    const bodyEnd = bodyStart + length * 2;
    if (bodyEnd > result.length) continue;
    const text = bytesToUtf8(result.slice(bodyStart, bodyEnd));
    if (/q:\s*title|title:|description:|resolution/i.test(text)) {
      offsetIndex = i;
      break;
    }
  }
  if (offsetIndex == null || offsetIndex < 1) {
    throw new Error("could not locate ancillaryData in getQuestion result");
  }

  const creator = addressFromWord(wordAt(result, base + (offsetIndex - 1) * 32));
  return { requestTimestamp, creator };
}

/** Hard ceiling on the decoded array length. A market's official-context log
 * is a handful of entries; anything near this is a corrupt/hostile RPC
 * response, and trusting its length word verbatim would spin a near-infinite
 * loop / OOM. */
const MAX_UPDATES = 1000;

function decodeUpdates(raw: string): OfficialUpdate[] {
  if (!raw || raw === "0x") return [];
  const byteLength = (raw.length - 2) / 2;
  const base = Number(uintWord(wordAt(raw, 0)));
  if (!Number.isFinite(base) || base < 0 || base + 32 > byteLength) return [];
  const length = Number(uintWord(wordAt(raw, base)));
  if (!Number.isFinite(length) || length < 0 || length > MAX_UPDATES) {
    throw new Error(`decodeUpdates: implausible array length ${length}`);
  }
  // The offset table (length words) must itself fit inside the payload.
  if (base + 32 + length * 32 > byteLength) {
    throw new Error("decodeUpdates: offset table exceeds payload");
  }
  const updates: OfficialUpdate[] = [];

  for (let i = 0; i < length; i += 1) {
    const tupleOffset = Number(uintWord(wordAt(raw, base + 32 + i * 32)));
    const tupleBase = base + 32 + tupleOffset;
    // Each tuple needs at least its two head words (timestamp + text offset).
    if (!Number.isFinite(tupleOffset) || tupleOffset < 0 || tupleBase + 64 > byteLength) {
      throw new Error("decodeUpdates: tuple offset out of bounds");
    }
    const timestamp = Number(uintWord(wordAt(raw, tupleBase)));
    const textOffset = Number(uintWord(wordAt(raw, tupleBase + 32)));
    if (!Number.isFinite(textOffset) || textOffset < 0 || tupleBase + textOffset + 32 > byteLength) {
      throw new Error("decodeUpdates: text offset out of bounds");
    }
    const textBytes = decodeBytes(raw, tupleBase + textOffset);
    updates.push({ timestamp, iso: iso(timestamp), text: textBytes.text });
  }
  return updates;
}

/**
 * Read all official context updates for a market from the UMA CTF adapter.
 * Throws on RPC/decode failure — callers handle retry/fallback.
 */
export async function getOfficialUpdates(input: {
  resolvedBy: string;
  questionID: string;
  /** 可选墙钟预算(2026-07-19 审查 §5):两次串行 ethCall 无预算时最坏 ~120s,
   * chain-watch 的 enrich 项会冲破 SIGTERM。前一半给 getQuestion,余量给
   * getUpdates。 */
  budgetMs?: number;
}): Promise<{ updates: OfficialUpdate[]; creator: string | null }> {
  const deadline = input.budgetMs != null ? Date.now() + Math.max(0, input.budgetMs) : null;
  const questionResult = await ethCall(
    input.resolvedBy,
    `${SELECTORS.getQuestion}${input.questionID.slice(2)}`,
    deadline == null ? undefined : Math.max(0, Math.floor((deadline - Date.now()) / 2))
  );
  const question = decodeQuestionWithCreator(questionResult);
  if (!question?.creator) return { updates: [], creator: null };

  const updateData = [
    SELECTORS.getUpdates,
    input.questionID.slice(2),
    addressArg(question.creator),
  ].join("");
  const rawUpdates = await ethCall(
    input.resolvedBy,
    updateData,
    deadline == null ? undefined : Math.max(0, deadline - Date.now())
  );
  return {
    updates: decodeUpdates(rawUpdates).sort((a, b) => a.timestamp - b.timestamp),
    creator: question.creator,
  };
}

// ── Stance classification ──

/** 宣告类裁定(declarative):官方文本里出现 "will/should resolve to X" 这类
 * 把答案直接印在脸上的措辞。历史兑现率 98.8%(vs 前瞻类 87%,见官方行为规律
 * 研究 2026-07-14)。执行侧据此启用宣告扫单模式 —— 该子类里"少赚"的成本远
 * 高于"多付几个价位"的成本,故只在此子类放宽限价帽,不做全局放宽。
 * 当前三个 high 置信返回全部来自该分支,显式打标以防后续新增 high 路径时
 * 语义悄悄漂移(闸门只准看这个布尔,不准按 confidence 反推)。 */
export function stanceFromText(text: string | null | undefined): {
  stance: string;
  confidence: "high" | "medium" | "low" | "none";
  declarative?: boolean;
} {
  const lower = String(text ?? "").toLowerCase();
  if (!lower) return { stance: "none", confidence: "none" };
  if (/remain open|not enough information|open investigation|clear resolution is reached/.test(lower)) {
    return { stance: "stay_open", confidence: "medium" };
  }
  // Lazy, boundary-terminated capture. The old greedy `[a-z0-9 ._+-]+` ate the
  // sentence-final period and any trailing words ("no." → resolve_to_"no."; a
  // real "No" ruling became an unmatchable resolve_to garbage stance). Capture
  // up to the first quote / sentence punctuation / newline / end.
  const explicitOutcome = lower.match(
    /(?:should\s+resolve\s+to|will(?:\s+immediately)?\s+resolve\s+to|resolves?\s+to|resolved?\s+as)\s+["“']?([a-z0-9][a-z0-9 _+-]{0,60}?)\s*(?:["”']|[.,;:!?\n]|$)/
  );
  if (explicitOutcome?.[1]) {
    // Guard BEFORE trusting the verb phrase: the widened verb set (bare
    // "resolves to" / "resolved as") would otherwise turn negated sentences
    // ("will not resolve to 'Yes'"), conditional rules ("will resolve to
    // 'Yes' if confirmed") and narrative time references ("has not resolved
    // as of this update") into high-confidence rulings.
    const matchIdx = explicitOutcome.index ?? 0;
    const sentenceStart =
      Math.max(
        lower.lastIndexOf(".", matchIdx),
        lower.lastIndexOf(";", matchIdx),
        lower.lastIndexOf("!", matchIdx),
        lower.lastIndexOf("?", matchIdx),
        lower.lastIndexOf("\n", matchIdx)
      ) + 1;
    const relEnd = lower.slice(matchIdx).search(/[.;!?\n]/);
    const sentence = lower.slice(
      sentenceStart,
      relEnd === -1 ? lower.length : matchIdx + relEnd
    );
    const preClause = lower.slice(sentenceStart, matchIdx);
    const negated =
      /\b(?:not|never|cannot|can'?t|won'?t|wouldn'?t|shouldn'?t|isn'?t|hasn'?t|no longer)\b/.test(preClause);
    const conditional =
      /\b(?:if|unless|until|only if|provided that|in the event)\b/.test(sentence);
    const narrative = /resolved?\s+as\s+of\b/.test(sentence);
    if (negated || conditional || narrative) {
      return { stance: "rule_context", confidence: "low" };
    }
    const outcome = explicitOutcome[1].replace(/[.,;:!?"'”’]+$/g, "").trim();
    // Exact yes/no (optionally followed by procedural qualifiers like "once
    // announced") folds to a direct stance. Any other multi-word label — "no
    // change", "no deal", a candidate name — must stay a resolve_to_* stance
    // so alignment is decided against the market's real outcome names instead
    // of being force-folded into YES/NO (a "No Change" bucket that should WIN
    // must not be read as stance NO).
    const folded = outcome.match(
      /^(yes|no)(?:\s+(?:once|when|upon|after|per|based|following)\b.*)?$/
    );
    if (folded) {
      return folded[1] === "yes"
        ? { stance: "YES", confidence: "high", declarative: true }
        : { stance: "NO", confidence: "high", declarative: true };
    }
    const norm = outcome.replace(/\s+/g, "_");
    // A ruling names a short outcome label; a 5+ word capture is almost
    // always a narrative clause the widened verbs snagged ("officials
    // updated the underlying data…") — keep it out of the directional path.
    if (norm && outcome.split(/\s+/).length <= 4) {
      return { stance: `resolve_to_${norm}`, confidence: "high", declarative: true };
    }
    return { stance: "rule_context", confidence: "low" };
  }
  if (/per the rules/.test(lower) && /will resolve to/.test(lower) && /\bif\b/.test(lower)) {
    return { stance: "rule_context", confidence: "low" };
  }
  // Word-bounded qualify test that excludes "disqualif…" (a NO-signal that the
  // old substring test mis-read as leans_YES) and drops purely procedural
  // phrasing ("will be officially announced") that carries no direction.
  const positiveQualify = /(?<![a-z])qualif(?:y|ies|ying)\b|qualify toward|officially listed/;
  const negatedQualify =
    /does not qualify|do not qualify|do not alone constitute|not qualify|will not qualify|not count|does not count|not alone meet/;
  if (positiveQualify.test(lower) && !/disqualif/.test(lower) && !negatedQualify.test(lower)) {
    return { stance: "leans_YES", confidence: "medium" };
  }
  if (
    /does not qualify|do not qualify|do not alone constitute|not qualify|will not qualify|not count|does not count|data which is clearly erroneous will not qualify|not alone meet/.test(lower)
  ) {
    return { stance: "leans_NO", confidence: "medium" };
  }
  if (/updated for clarity|language has been updated|rules have been updated/.test(lower)) {
    return { stance: "clarity_only", confidence: "low" };
  }
  if (/aware of the dispute/.test(lower)) {
    return { stance: "dispute_notice", confidence: "medium" };
  }
  return { stance: "rule_context", confidence: "low" };
}

/** True when any update text promises refunds (or a 50/50 split) — the
 * "losing" side then carries no real risk and the spread is not edge.
 * Negated mentions ("no refunds will be issued", "will not be refunded",
 * "non-refundable") are officials saying settlement proceeds normally —
 * the exact opposite — so they must NOT trip this flag. */
export function detectRefundClause(texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => {
    const lower = String(t ?? "").toLowerCase();
    if (/\b50\s*\/\s*50\b/.test(lower)) return true;
    if (!/refund/.test(lower)) return false;
    const negated =
      /\b(?:no|not|never|won'?t|without)\b[^.;]{0,40}?refund|non-?refundable|refunds?\s+will\s+not\b/;
    // Strip negated mentions; a refund clause stands only if a bare
    // affirmative mention survives.
    const stripped = lower.replace(new RegExp(negated.source, "g"), "");
    return /refund/.test(stripped);
  });
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function marketIsDisputed(
  market: Pick<GammaMarket, "umaResolutionStatus" | "umaResolutionStatuses"> | null | undefined
): boolean {
  if (!market) return false;
  // Same trim/lowercase normalization as the scanner — a Gamma casing drift
  // must not silently disable the price fallback.
  if (market.umaResolutionStatus?.trim().toLowerCase() === "disputed") return true;
  return parseJsonArray(market.umaResolutionStatuses).some(
    (s) => s.trim().toLowerCase() === "disputed"
  );
}

function topOutcome(
  market: Pick<GammaMarket, "outcomes" | "outcomePrices"> | null | undefined
): { price: number; label: string } | null {
  const prices = parseJsonArray(market?.outcomePrices).map(Number);
  const outcomes = parseJsonArray(market?.outcomes);
  if (!prices.length) return null;
  let idx = 0;
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i] > prices[idx]) idx = i;
  }
  const price = prices[idx];
  const label = outcomes[idx];
  if (!Number.isFinite(price) || label == null) return null;
  return { price, label };
}

/**
 * Price/dispute fallback: when the official text gives no direction (or hasn't
 * been written yet) but the market is already disputed and priced at an
 * extreme, treat the leading side as the implied resolution. The confidence
 * flag lets downstream consumers weight these lower than an explicit call.
 */
export function fallbackStanceFromMarket(
  market:
    | Pick<GammaMarket, "umaResolutionStatus" | "umaResolutionStatuses" | "outcomes" | "outcomePrices">
    | null
    | undefined
): { stance: string; confidence: "price_fallback"; price: number } | null {
  if (!market || !marketIsDisputed(market)) return null;
  const top = topOutcome(market);
  if (!top || top.price < PRICE_FALLBACK_MIN) return null;
  const norm = String(top.label).toLowerCase();
  const stance =
    norm === "yes" ? "YES" : norm === "no" ? "NO" : `resolve_to_${norm.replace(/\s+/g, "_")}`;
  return { stance, confidence: "price_fallback", price: top.price };
}

// ── Alignment ──

function normalizeOutcomeName(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Relate an official stance to one side of a market. `outcomeTokens` (all
 * outcome names of the market) lets resolve_to_<x> distinguish "the sibling
 * side loses" from "this ruling talks about a label this market doesn't have"
 * — the latter must stay `unknown` so an event-level ruling is never projected
 * onto the wrong bucket.
 */
export function stanceAlignment(
  stance: string,
  outcome: string,
  outcomeTokens?: Record<string, string> | null
): "aligned" | "contradicts" | "unknown" {
  const side = normalizeOutcomeName(outcome);
  if (stance === "YES" || stance === "leans_YES") {
    if (side === "yes") return "aligned";
    if (side === "no") return "contradicts";
    return "unknown";
  }
  if (stance === "NO" || stance === "leans_NO") {
    if (side === "no") return "aligned";
    if (side === "yes") return "contradicts";
    return "unknown";
  }
  if (stance.startsWith("resolve_to_")) {
    const target = stance.slice("resolve_to_".length);
    if (target === side) return "aligned";
    const knownOutcomes = Object.keys(outcomeTokens ?? {}).map(normalizeOutcomeName);
    if (knownOutcomes.includes(target)) return "contradicts";
    return "unknown";
  }
  return "unknown";
}

// ── Assembly ──

/**
 * Combine on-chain updates and the Gamma market snapshot into an
 * OfficialContext. Text wins; when the text carries no direction (or there is
 * no text) and the market is disputed at an extreme price, the price fallback
 * supplies the direction. Returns null when there is nothing to show at all.
 */
export function buildOfficialContext(
  updates: OfficialUpdate[],
  market: GammaMarket | null
): OfficialContext | null {
  const latest = updates.length > 0 ? updates[updates.length - 1] : null;

  // Newest directional text wins (two-stage pattern: boundary note first,
  // ruling appended after the dispute).
  let textStance: { stance: string; confidence: "high" | "medium" | "low" | "none" } | null = null;
  let directionalIdx = -1;
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const classified = stanceFromText(updates[i].text);
    if (isDirectionalStance(classified.stance)) {
      textStance = classified;
      directionalIdx = i;
      break;
    }
  }

  // Walk-back guard: if officials posted a stay_open / dispute_notice AFTER the
  // chosen directional ruling, they explicitly returned the market to undecided.
  // The stale ruling must not keep being presented as the current direction —
  // adopt the later directionless stance instead (which drops official_direction
  // _backed; a price fallback may still supply a lower-confidence hint).
  if (textStance && directionalIdx >= 0) {
    for (let i = updates.length - 1; i > directionalIdx; i -= 1) {
      const laterStance = stanceFromText(updates[i].text);
      if (laterStance.stance === "stay_open" || laterStance.stance === "dispute_notice") {
        textStance = laterStance;
        break;
      }
    }
  }

  if (!textStance && latest) textStance = stanceFromText(latest.text);

  const refundClause = detectRefundClause(updates.map((u) => u.text));

  if (textStance && isDirectionalStance(textStance.stance)) {
    return {
      stance: textStance.stance,
      confidence: textStance.confidence,
      via: "text",
      updateCount: updates.length,
      lastUpdateAt: latest?.iso ?? null,
      excerpt: latest ? latest.text.slice(0, EXCERPT_MAX_CHARS) : null,
      refundClause,
    };
  }

  const fallback = fallbackStanceFromMarket(market);
  if (fallback) {
    return {
      stance: fallback.stance,
      confidence: "price_fallback",
      via: "price_fallback",
      updateCount: updates.length,
      lastUpdateAt: latest?.iso ?? null,
      excerpt: latest ? latest.text.slice(0, EXCERPT_MAX_CHARS) : null,
      refundClause,
    };
  }

  if (!latest) return null;
  return {
    stance: textStance?.stance ?? "none",
    confidence: textStance?.confidence ?? "none",
    via: "text",
    updateCount: updates.length,
    lastUpdateAt: latest.iso,
    excerpt: latest.text.slice(0, EXCERPT_MAX_CHARS),
    refundClause,
  };
}

/**
 * Fetch + classify official context for disputed opportunities, in place.
 * One RPC round per unique (adapter, questionID) — both sides of a market and
 * duplicate buckets share the cached result. Never throws: RPC failures fall
 * back to the price-implied stance (pure local data), then to null.
 */
export async function attachOfficialContexts(
  opportunities: Opportunity[],
  marketsByConditionId: Map<string, GammaMarket>,
  concurrency = 4
): Promise<void> {
  const unique = new Map<string, { resolvedBy: string; questionID: string }>();
  for (const opp of opportunities) {
    const qid = adapterQuestionID(opp);
    if (!isHex(opp.resolvedBy, 20) || !qid) continue;
    unique.set(`${opp.resolvedBy.toLowerCase()}:${qid.toLowerCase()}`, {
      resolvedBy: opp.resolvedBy,
      questionID: qid,
    });
  }

  const updatesByKey = new Map<string, OfficialUpdate[]>();
  const entries = [...unique.entries()];
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([key, input]) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const { updates } = await getOfficialUpdates(input);
            updatesByKey.set(key, updates);
            return;
          } catch (err) {
            if (attempt === 0) continue;
            console.warn(
              `[officialContext] getUpdates failed for ${input.questionID}: ${err instanceof Error ? err.message : String(err)}`
            );
            updatesByKey.set(key, []);
          }
        }
      })
    );
  }

  for (const opp of opportunities) {
    const qid = adapterQuestionID(opp);
    const key =
      isHex(opp.resolvedBy, 20) && qid
        ? `${opp.resolvedBy.toLowerCase()}:${qid.toLowerCase()}`
        : null;
    const updates = (key ? updatesByKey.get(key) : null) ?? [];
    const market = marketsByConditionId.get(opp.conditionId) ?? null;
    opp.officialContext = buildOfficialContext(updates, market);
  }
}

/**
 * Decision integration for an opportunity carrying an officialContext:
 * - stance aligned with this side  → informational "official_direction_backed"
 * - stance contradicts this side   → never actionable ("official_contradicts_side")
 * - refund clause present          → never actionable ("refund_clause")
 */
export function applyOfficialContextDecision(opp: Opportunity): void {
  const ctx = opp.officialContext;
  if (!ctx) return;
  const reasons = opp.decisionReasons ?? (opp.decisionReasons = []);
  const demote = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (opp.decision === "actionable") opp.decision = "observe";
  };

  if (ctx.refundClause) demote("refund_clause");

  if (isDirectionalStance(ctx.stance)) {
    const alignment = stanceAlignment(ctx.stance, opp.outcome, opp.outcomeTokens);
    if (alignment === "aligned") {
      // A refund clause means the "losing" side is made whole — there is no
      // edge, so this is NOT an official direction to trade. Suppress the
      // backing reason entirely so the notifier's rule (c) can't email it as
      // an "official direction" play.
      if (!ctx.refundClause && !reasons.includes("official_direction_backed")) {
        reasons.push("official_direction_backed");
      }
    } else if (alignment === "contradicts") {
      demote("official_contradicts_side");
    }
  }
}
