import type { Opportunity, OracleResolutionState } from "../types";
import { rpcPostJson } from "./rpcTransport";

interface QuestionData {
  requestTimestamp: bigint;
  manualResolutionTimestamp: bigint;
  resolved: boolean;
  paused: boolean;
  reset: boolean;
  ancillaryDataHex: string;
}

interface OptimisticOracleRequest {
  proposer: string;
  disputer: string;
  settled: boolean;
  expirationTime: bigint;
}

export interface OracleStateInspection {
  state: OracleResolutionState;
  details: string;
}

const DEFAULT_POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
];

const GET_QUESTION_SELECTOR = "0x58c039cd";
const READY_SELECTOR = "0xfcac49a2";
const OPTIMISTIC_ORACLE_SELECTOR = "0x22302922";
const GET_REQUEST_SELECTOR = "0xa9904f9b";
const HAS_PRICE_SELECTOR = "0xbc58ccaa";
const YES_OR_NO_IDENTIFIER = "YES_OR_NO_QUERY";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const TWO_255 = BIG_ONE << BigInt(255);
const TWO_256 = BIG_ONE << BigInt(256);

function rpcUrls(): string[] {
  // Read the SAME env var the rest of the deployment configures
  // (ONCHAIN_RPC_URLS, comma-separated) so on-chain reads use the operator's
  // tuned RPC list instead of silently falling back to the hardcoded public
  // defaults. POLYGON_RPC_URL (single URL) is still honored for back-compat.
  // Configured URLs go first; the hardcoded defaults remain as last-resort
  // fallbacks. De-duplicated to avoid hitting the same endpoint twice.
  const fromList = (process.env.ONCHAIN_RPC_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const single = process.env.POLYGON_RPC_URL?.trim();
  const ordered = [
    ...fromList,
    ...(single ? [single] : []),
    ...DEFAULT_POLYGON_RPCS,
  ];
  return [...new Set(ordered)];
}

export function isHex(value: string | null | undefined, bytes: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  );
}

function normalizeAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "")}`;
}

function isZeroAddress(address: string): boolean {
  return normalizeAddress(address) === ZERO_ADDRESS;
}

function wordAt(hex: string, byteOffset: number): string {
  return hex.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64);
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

function intWord(word: string): bigint {
  const unsigned = uintWord(word);
  return unsigned >= TWO_255 ? unsigned - TWO_256 : unsigned;
}

function boolWord(word: string): boolean {
  return uintWord(word) !== BIG_ZERO;
}

function addressWord(word: string): string {
  return `0x${word.slice(24)}`;
}

function uintArg(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytes32Ascii(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").padEnd(64, "0");
}

/**
 * @param budgetMs 可选墙钟预算(2026-07-19 审查 §5):不传时每 URL 固定 10s
 *   串行 4-6 个 URL,单次最坏 ~60s —— chain-watch 单 enrich 项 3 次 ethCall
 *   最坏可冲破 170s SIGTERM。传入后单 URL 超时取
 *   min(10s, 剩余预算/剩余URL数),预算耗尽即停止尝试后续 URL。
 */
export async function ethCall(to: string, data: string, budgetMs?: number): Promise<string> {
  let lastError: Error | null = null;
  const urls = rpcUrls();
  const deadline = budgetMs != null ? Date.now() + Math.max(0, budgetMs) : null;

  for (let i = 0; i < urls.length; i += 1) {
    const rpc = urls[i];
    let perUrlMs = 10_000;
    if (deadline != null) {
      perUrlMs = Math.min(10_000, Math.floor((deadline - Date.now()) / (urls.length - i)));
      if (perUrlMs < 300) break; // 预算耗尽:剩余 URL 不再尝试,抛最后错误
    }
    try {
      // rpcPostJson 先走代理再落直连(2026-08-07)。perUrlMs 是这个端点的**总**
      // 预算,两条路共享 —— 预算算术因此完全不变,而黑洞防护还在:传输层的
      // 总闸覆盖连接/TLS/响应体全程,不会退回 undici ~300s 默认值。
      const result = await rpcPostJson<string>(rpc, "eth_call", [{ to, data }, "latest"], {
        timeoutMs: perUrlMs,
      });
      // 传输层只判 result === undefined;这里保留原有的更严判据 —— 空串是
      // 端点没真答上来,应换下一路,而不是当成"合法的空返回"往下游送。
      if (!result) throw new Error("empty eth_call result");
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("all Polygon RPC calls failed");
}

function decodeQuestion(result: string): QuestionData | null {
  if (!result || result === "0x") return null;
  const tupleOffset = Number(uintWord(wordAt(result, 0)));
  const word = (index: number) => wordAt(result, tupleOffset + index * 32);

  // Adapter versions lay QuestionData out differently. The dynamic
  // `ancillaryData` offset is always the last head word, so its value tells
  // us the head size: V3.1/V4 have a 12-word head (offset 0x180), V2 a
  // 10-word head (offset 0x140). Reading V2 with V3.1 offsets shifts every
  // bool one word left — a resolved V2 market then reads as paused
  // (w7 lands on rewardToken, verified on-chain against market 557759).
  const V3_HEAD = 12 * 32;
  const V2_HEAD = 10 * 32;
  let layout: { manual: number; resolved: number; paused: number; reset: number };
  let ancillaryOffset: number;
  if (Number(uintWord(word(11))) === V3_HEAD) {
    layout = { manual: 4, resolved: 5, paused: 6, reset: 7 };
    ancillaryOffset = V3_HEAD;
  } else if (Number(uintWord(word(9))) === V2_HEAD) {
    // V2 (0x6a9d2226…): requestTimestamp, reward, proposalBond,
    // emergencyResolutionTimestamp, resolved, paused, reset, rewardToken,
    // creator, ancillaryData
    layout = { manual: 3, resolved: 4, paused: 5, reset: 6 };
    ancillaryOffset = V2_HEAD;
  } else {
    return null;
  }

  const ancillaryLength = Number(
    uintWord(wordAt(result, tupleOffset + ancillaryOffset))
  );
  const ancillaryData = result.slice(
    2 + (tupleOffset + ancillaryOffset + 32) * 2,
    2 + (tupleOffset + ancillaryOffset + 32 + ancillaryLength) * 2
  );

  if (ancillaryLength === 0) return null;

  return {
    requestTimestamp: uintWord(word(0)),
    manualResolutionTimestamp: uintWord(word(layout.manual)),
    resolved: boolWord(word(layout.resolved)),
    paused: boolWord(word(layout.paused)),
    reset: boolWord(word(layout.reset)),
    ancillaryDataHex: `0x${ancillaryData}`,
  };
}

function encodeOracleRequestCall(
  selector: string,
  adapter: string,
  requestTimestamp: bigint,
  ancillaryDataHex: string
): string {
  const bytes = ancillaryDataHex.replace(/^0x/, "");
  const byteLength = bytes.length / 2;
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  const paddedBytes = bytes.padEnd(paddedLength, "0");

  return [
    selector,
    addressArg(adapter),
    bytes32Ascii(YES_OR_NO_IDENTIFIER),
    uintArg(requestTimestamp),
    uintArg(BigInt(128)),
    uintArg(BigInt(byteLength)),
    paddedBytes,
  ].join("");
}

function decodeRequest(result: string): OptimisticOracleRequest {
  const word = (index: number) => wordAt(result, index * 32);
  // Read proposed/resolved prices even though classification currently only
  // needs existence fields; this catches malformed return data early.
  intWord(word(11));
  intWord(word(12));
  return {
    proposer: addressWord(word(0)),
    disputer: addressWord(word(1)),
    settled: boolWord(word(3)),
    expirationTime: uintWord(word(13)),
  };
}

function classifyOracleState(
  question: QuestionData,
  request: OptimisticOracleRequest,
  ready: boolean,
  hasPrice: boolean
): OracleStateInspection {
  const proposerActive = !isZeroAddress(request.proposer);
  const disputerActive = !isZeroAddress(request.disputer);

  if (question.resolved || request.settled) {
    return { state: "resolved", details: "adapter/request is already settled" };
  }
  if (question.paused || question.manualResolutionTimestamp > BIG_ZERO) {
    return {
      state: "manual_review",
      details: "adapter question is paused or flagged for manual resolution",
    };
  }
  if (ready || hasPrice) {
    return {
      state: "ready",
      details: "UMA price is available; market can be resolved by a caller",
    };
  }
  if (question.reset && disputerActive) {
    return {
      state: "second_dispute",
      details: "post-reset request is disputed again; likely waiting on UMA/DVM",
    };
  }
  if (question.reset && !proposerActive && !disputerActive) {
    return {
      state: "reset_stalled",
      details:
        "first dispute reset the adapter question, but the current UMA request has no active proposal and no price",
    };
  }
  if (proposerActive && !disputerActive) {
    return {
      state: "active_proposal",
    details: request.expirationTime > BIG_ZERO
        ? "UMA proposal is live and waiting for liveness to expire"
        : "UMA proposal is live",
    };
  }
  return {
    state: "requested",
    details: "UMA request exists, but no active proposal or price is available",
  };
}

async function inspectOracleResolutionState(
  adapter: string,
  questionID: string
): Promise<OracleStateInspection | null> {
  if (!isHex(adapter, 20) || !isHex(questionID, 32)) return null;

  try {
    const questionResult = await ethCall(
      adapter,
      `${GET_QUESTION_SELECTOR}${questionID.slice(2)}`
    );
    const question = decodeQuestion(questionResult);
    if (!question) return null;

    const optimisticOracle = addressWord(
      (await ethCall(adapter, OPTIMISTIC_ORACLE_SELECTOR)).slice(-64)
    );
    const ready = boolWord(
      (await ethCall(adapter, `${READY_SELECTOR}${questionID.slice(2)}`)).slice(
        -64
      )
    );
    const requestCall = encodeOracleRequestCall(
      GET_REQUEST_SELECTOR,
      adapter,
      question.requestTimestamp,
      question.ancillaryDataHex
    );
    const hasPriceCall = encodeOracleRequestCall(
      HAS_PRICE_SELECTOR,
      adapter,
      question.requestTimestamp,
      question.ancillaryDataHex
    );
    const [requestResult, hasPriceResult] = await Promise.all([
      ethCall(optimisticOracle, requestCall),
      ethCall(optimisticOracle, hasPriceCall),
    ]);

    return classifyOracleState(
      question,
      decodeRequest(requestResult),
      ready,
      boolWord(hasPriceResult.slice(-64))
    );
  } catch {
    return {
      state: "unknown",
      details: "could not inspect UMA adapter state from public Polygon RPC",
    };
  }
}

/**
 * The adapter's storage key for a market. For negRisk markets `questionID`
 * encodes the NegRiskOperator marketId+index and getQuestion/getUpdates
 * return empty structs — the real key is Gamma's `negRiskRequestID`.
 * Verified on-chain 2026-07-04 (3/3 neg-risk disputed markets read only
 * via negRiskRequestID).
 */
export function adapterQuestionID(
  input: Pick<Opportunity, "negRisk" | "negRiskRequestID" | "questionID">
): string | null {
  if (input.negRisk === true && isHex(input.negRiskRequestID, 32)) {
    return input.negRiskRequestID;
  }
  return isHex(input.questionID, 32) ? input.questionID : null;
}

export async function inspectOracleResolutionStates(
  opportunities: Opportunity[],
  concurrency = 4
): Promise<Map<string, OracleStateInspection>> {
  const unique = new Map<string, { adapter: string; questionID: string }>();
  for (const opp of opportunities) {
    const qid = adapterQuestionID(opp);
    if (!isHex(opp.resolvedBy, 20) || !qid) continue;
    unique.set(`${opp.resolvedBy.toLowerCase()}:${qid}`, {
      adapter: opp.resolvedBy,
      questionID: qid,
    });
  }

  const entries = [...unique.entries()];
  const result = new Map<string, OracleStateInspection>();

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const inspected = await Promise.all(
      batch.map(async ([key, input]) => ({
        key,
        state: await inspectOracleResolutionState(input.adapter, input.questionID),
      }))
    );
    for (const { key, state } of inspected) {
      if (state) result.set(key, state);
    }
  }

  return result;
}
