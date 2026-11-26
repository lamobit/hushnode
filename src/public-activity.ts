import type { NetworkName } from "@railgun-community/shared-models";
import { forwardAbort, throwIfAborted } from "./abort.js";
import { readJsonWithLimit } from "./json-response.js";
import { createLogger } from "./logger.js";
import { networkFor } from "./networks.js";

const log = createLogger("public-activity");

const BLOCKSCOUT_TIMEOUT_MS = 12_000;
const BLOCKSCOUT_TOTAL_TIMEOUT_MS = 15_000;
const BLOCKSCOUT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BLOCKSCOUT_MAX_PAGES = 3;
const BLOCKSCOUT_MAX_PAGE_PARAMS = 16;
const BLOCKSCOUT_MAX_PAGE_PARAM_KEY_LENGTH = 128;
const BLOCKSCOUT_MAX_PAGE_PARAM_VALUE_LENGTH = 512;
const BLOCKSCOUT_MAX_PAGE_URL_LENGTH = 2_048;
export const MAX_PUBLIC_ACTIVITY_ITEMS = 300;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_DECIMAL_UINT256_LENGTH = 78;
const MAX_HEX_UINT256_LENGTH = 66;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_LABEL_LENGTH = 40;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const FORMAT_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/gu;
const TRUSTED_SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+$/@-]*$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PublicActivityRequestOptions = {
  signal?: AbortSignal;
};

export type PublicActivityFetcher = (
  network: NetworkName,
  address: string,
  options?: PublicActivityRequestOptions,
) => Promise<PublicActivityResult>;

export type PublicActivityLeg = {
  direction: "in" | "out";
  tokenAddress: string | null;
  symbol: string;
  decimals: number;
  value: string;
};

export type PublicActivityItem = {
  hash: string;
  timestamp: number;
  blockNumber: number | null;
  fee: string | null;
  status: "completed" | "failed";
  from: string | null;
  to: string | null;
  legs: PublicActivityLeg[];
};

export type PublicActivityWarning =
  | "TRANSACTION_HISTORY_UNAVAILABLE"
  | "TOKEN_TRANSFER_HISTORY_UNAVAILABLE"
  | "TRANSACTION_HISTORY_TRUNCATED"
  | "TOKEN_TRANSFER_HISTORY_TRUNCATED"
  | "TRANSACTION_HISTORY_INVALID"
  | "TOKEN_TRANSFER_HISTORY_INVALID";

export type PublicActivityResult = {
  items: PublicActivityItem[];
  complete: boolean;
  warnings: PublicActivityWarning[];
};

type DraftLeg = {
  direction: "in" | "out";
  tokenAddress: string | null;
  symbol: string;
  decimals: number;
  value: bigint;
};

type ActivityDraft = {
  hash: string;
  timestamp?: number;
  blockNumber?: number;
  fee?: string;
  status: "completed" | "failed";
  from?: string;
  to?: string;
  legs: Map<string, DraftLeg>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const addressValue = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const hash = stringValue(value.hash);
  return hash && ADDRESS_PATTERN.test(hash) ? hash.toLowerCase() : undefined;
};

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const timestampValue = (value: unknown): number | undefined => {
  const bounded = (timestamp: number): number | undefined =>
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= MAX_TIMESTAMP_MS
      ? timestamp
      : undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return bounded(
      value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1_000),
    );
  }
  const raw = stringValue(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return bounded(parsed);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return bounded(
    numeric > 10_000_000_000
      ? Math.floor(numeric)
      : Math.floor(numeric * 1_000),
  );
};

const blockNumberValue = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const decimalsValue = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255
    ? parsed
    : undefined;
};

const bigintValue = (value: unknown): bigint | undefined => {
  const raw = stringValue(value);
  if (!raw || (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw))) {
    return undefined;
  }
  const maxLength = raw.startsWith("0x")
    ? MAX_HEX_UINT256_LENGTH
    : MAX_DECIMAL_UINT256_LENGTH;
  if (raw.length > maxLength) return undefined;
  try {
    const parsed = BigInt(raw);
    return parsed <= MAX_UINT256 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

const tokenSymbolFor = (
  reserved: ReadonlySet<string>,
  tokenAddress: string,
  value: unknown,
): string => {
  const raw = stringValue(value) ?? "";
  const cleaned = raw.replace(FORMAT_CHARACTER_PATTERN, "").trim();
  if (
    !cleaned ||
    cleaned !== raw ||
    cleaned.length > MAX_LABEL_LENGTH ||
    !TRUSTED_SYMBOL_PATTERN.test(cleaned) ||
    reserved.has(cleaned.toLowerCase())
  ) {
    return `ERC-20 ${shortAddress(tokenAddress)}`;
  }
  return `${cleaned} · ${shortAddress(tokenAddress)}`;
};

const directionFor = (
  owner: string,
  from: string | undefined,
  to: string | undefined,
): "in" | "out" | undefined => {
  const outgoing = from === owner;
  const incoming = to === owner;
  if (incoming && !outgoing) return "in";
  if (outgoing && !incoming) return "out";
  return undefined;
};

const draftFor = (
  drafts: Map<string, ActivityDraft>,
  hash: string,
  status: "completed" | "failed",
): ActivityDraft => {
  const key = hash.toLowerCase();
  const existing = drafts.get(key);
  if (existing) {
    if (status === "failed") existing.status = "failed";
    return existing;
  }
  const draft: ActivityDraft = { hash, status, legs: new Map() };
  drafts.set(key, draft);
  return draft;
};

const addLeg = (
  draft: ActivityDraft,
  direction: "in" | "out",
  tokenAddress: string | null,
  symbol: string,
  decimals: number,
  value: bigint,
): void => {
  if (value <= 0n) return;
  const key = `${direction}:${tokenAddress?.toLowerCase() ?? "native"}`;
  const existing = draft.legs.get(key);
  if (existing) {
    existing.value += value;
    return;
  }
  draft.legs.set(key, {
    direction,
    tokenAddress,
    symbol,
    decimals,
    value,
  });
};

export const mapPublicActivity = (
  network: NetworkName,
  ownerAddress: string,
  transactions: readonly unknown[],
  tokenTransfers: readonly unknown[],
): PublicActivityItem[] => {
  if (!ADDRESS_PATTERN.test(ownerAddress)) return [];
  const owner = ownerAddress.toLowerCase();
  const definition = networkFor(network);
  const knownTokens = new Map(
    definition.tokens.map((token) => [token.address.toLowerCase(), token]),
  );
  const reservedSymbols = new Set(
    [definition.nativeSymbol, ...definition.tokens.map((token) => token.symbol)]
      .map((symbol) => symbol.toLowerCase()),
  );
  const drafts = new Map<string, ActivityDraft>();
  const failedHashes = new Set<string>();

  for (const value of transactions) {
    if (!isRecord(value)) continue;
    const hash = stringValue(value.hash);
    if (!hash || !HASH_PATTERN.test(hash)) continue;
    const status = stringValue(value.status);
    const failed = Boolean(status && status !== "ok");
    if (failed) failedHashes.add(hash.toLowerCase());
    const from = addressValue(value.from);
    const to = addressValue(value.to);
    const direction = directionFor(owner, from, to);
    if (!direction) continue;
    const raw = bigintValue(value.value);
    const draft = draftFor(drafts, hash, failed ? "failed" : "completed");
    draft.timestamp ??= timestampValue(value.timestamp);
    draft.blockNumber ??= blockNumberValue(value.block_number);
    draft.from ??= from;
    draft.to ??= to;
    const fee = recordValue(value.fee);
    const feeValue = fee ? bigintValue(fee.value) : undefined;
    if (feeValue !== undefined) draft.fee = feeValue.toString();
    if (raw !== undefined && raw > 0n) {
      addLeg(
        draft,
        direction,
        null,
        definition.nativeSymbol,
        definition.nativeDecimals,
        raw,
      );
    }
  }

  for (const value of tokenTransfers) {
    if (!isRecord(value)) continue;
    const hash = stringValue(value.transaction_hash);
    if (!hash || !HASH_PATTERN.test(hash)) continue;
    if (failedHashes.has(hash.toLowerCase())) continue;
    const from = addressValue(value.from);
    const to = addressValue(value.to);
    const direction = directionFor(owner, from, to);
    if (!direction) continue;

    const token = recordValue(value.token);
    const total = recordValue(value.total);
    if (!token || !total) continue;
    const tokenAddress = stringValue(token.address_hash);
    if (!tokenAddress || !ADDRESS_PATTERN.test(tokenAddress)) continue;
    const normalizedAddress = tokenAddress.toLowerCase();
    const knownToken = knownTokens.get(normalizedAddress);
    const raw = bigintValue(total.value);
    const decimals =
      decimalsValue(total.decimals) ??
      decimalsValue(token.decimals) ??
      knownToken?.decimals;
    if (raw === undefined || decimals === undefined) continue;

    const draft = draftFor(drafts, hash, "completed");
    draft.timestamp ??= timestampValue(value.timestamp);
    draft.blockNumber ??= blockNumberValue(value.block_number);
    draft.from ??= from;
    draft.to ??= to;
    addLeg(
      draft,
      direction,
      normalizedAddress,
      knownToken?.symbol ??
        tokenSymbolFor(reservedSymbols, tokenAddress, token.symbol),
      decimals,
      raw,
    );
  }

  return [...drafts.values()]
    .filter((draft) => draft.legs.size > 0)
    .map((draft): PublicActivityItem => ({
      hash: draft.hash,
      timestamp: draft.timestamp ?? 0,
      blockNumber: draft.blockNumber ?? null,
      fee: draft.fee ?? null,
      status: draft.status,
      from: draft.from ?? null,
      to: draft.to ?? null,
      legs: [...draft.legs.values()].map((leg) => ({
        direction: leg.direction,
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        decimals: leg.decimals,
        value: leg.value.toString(),
      })),
    }))
    .sort((left, right) => right.timestamp - left.timestamp);
};

const itemsFrom = (value: unknown): unknown[] | undefined =>
  isRecord(value) && Array.isArray(value.items) ? value.items : undefined;

type NextPage = {
  url?: string;
  invalid: boolean;
};

const nextPageUrl = (
  currentUrl: string,
  value: unknown,
): NextPage => {
  if (value === undefined || value === null) return { invalid: false };
  if (!isRecord(value)) return { invalid: true };
  const next = new URL(currentUrl);
  let changed = false;
  let params = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    params += 1;
    if (
      params > BLOCKSCOUT_MAX_PAGE_PARAMS ||
      key.length === 0 ||
      key.length > BLOCKSCOUT_MAX_PAGE_PARAM_KEY_LENGTH
    ) {
      return { invalid: true };
    }
    const raw = value[key];
    if (
      raw === null ||
      raw === undefined ||
      (typeof raw !== "string" &&
        typeof raw !== "number" &&
        typeof raw !== "boolean")
    ) {
      continue;
    }
    const serialized = String(raw);
    if (serialized.length > BLOCKSCOUT_MAX_PAGE_PARAM_VALUE_LENGTH) {
      return { invalid: true };
    }
    next.searchParams.set(key, serialized);
    changed = true;
  }
  if (!changed) return { invalid: params > 0 };
  const url = next.toString();
  return url.length > BLOCKSCOUT_MAX_PAGE_URL_LENGTH
    ? { invalid: true }
    : { url, invalid: false };
};

const requestJson = async (
  url: string,
  fetchImpl: FetchLike,
  deadline: number,
  signal?: AbortSignal,
): Promise<unknown> => {
  throwIfAborted(signal);
  const origin = new URL(url).origin;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Blockscout deadline exceeded");
  const controller = new AbortController();
  const detachAbort = forwardAbort(signal, controller);
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(BLOCKSCOUT_TIMEOUT_MS, remaining),
  );
  timeout.unref();
  try {
    throwIfAborted(controller.signal);
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: "application/json",
        referer: `${origin}/`,
        "user-agent": "hush-node/0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`Blockscout HTTP ${response.status}`);
    }
    return await readJsonWithLimit(
      response,
      BLOCKSCOUT_MAX_RESPONSE_BYTES,
      controller.signal,
    );
  } finally {
    detachAbort();
    clearTimeout(timeout);
  }
};

const fetchPublicItems = async (
  url: string,
  fetchImpl: FetchLike,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ items: unknown[]; complete: boolean; invalid: boolean }> => {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let next: string | undefined = url;
  let complete = true;
  let invalid = false;
  for (let page = 0; page < BLOCKSCOUT_MAX_PAGES && next; page += 1) {
    throwIfAborted(signal);
    if (seen.has(next)) {
      complete = false;
      break;
    }
    seen.add(next);
    let payload: unknown;
    try {
      payload = await requestJson(next, fetchImpl, deadline, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (items.length === 0) throw error;
      log.debug("public history pagination stopped early", error);
      complete = false;
      break;
    }
    const pageItems = itemsFrom(payload);
    if (!pageItems) {
      log.debug("public history page has an invalid shape");
      complete = false;
      invalid = true;
      break;
    }
    const remaining = MAX_PUBLIC_ACTIVITY_ITEMS - items.length;
    if (pageItems.length > remaining) {
      for (const item of pageItems.slice(0, remaining)) items.push(item);
      complete = false;
      break;
    }
    for (const item of pageItems) items.push(item);
    const nextPageParams =
      isRecord(payload) && "next_page_params" in payload
        ? payload.next_page_params
        : undefined;
    if (
      nextPageParams !== undefined &&
      nextPageParams !== null &&
      !isRecord(nextPageParams)
    ) {
      log.debug("public history pagination has an invalid shape");
      complete = false;
      invalid = true;
      break;
    }
    const nextPage = nextPageUrl(
      next,
      nextPageParams,
    );
    if (nextPage.invalid) {
      log.debug("public history pagination exceeds its safety bounds");
      complete = false;
      invalid = true;
      break;
    }
    const nextUrl = nextPage.url;
    if (nextUrl && page === BLOCKSCOUT_MAX_PAGES - 1) {
      complete = false;
    }
    next = nextUrl;
    if (next && items.length >= MAX_PUBLIC_ACTIVITY_ITEMS) {
      complete = false;
      break;
    }
  }
  return { items, complete, invalid };
};

export const fetchPublicActivity = async (
  network: NetworkName,
  address: string,
  fetchImplOrOptions:
    | FetchLike
    | (PublicActivityRequestOptions & { fetchImpl?: FetchLike }) = {},
): Promise<PublicActivityResult> => {
  const options =
    typeof fetchImplOrOptions === "function"
      ? { fetchImpl: fetchImplOrOptions }
      : fetchImplOrOptions;
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  throwIfAborted(signal);
  if (!ADDRESS_PATTERN.test(address)) {
    return { items: [], complete: true, warnings: [] };
  }
  const definition = networkFor(network);
  const base = definition.blockscout.replace(/\/+$/, "");
  const encoded = encodeURIComponent(address);
  const transactionUrl = `${base}/api/v2/addresses/${encoded}/transactions`;
  const tokenTransferUrl = `${base}/api/v2/addresses/${encoded}/token-transfers?type=ERC-20`;
  const deadline = Date.now() + BLOCKSCOUT_TOTAL_TIMEOUT_MS;
  const [transactions, tokenTransfers] = await Promise.allSettled([
    fetchPublicItems(transactionUrl, fetchImpl, deadline, signal),
    fetchPublicItems(tokenTransferUrl, fetchImpl, deadline, signal),
  ]);
  throwIfAborted(signal);

  if (
    transactions.status === "rejected" &&
    tokenTransfers.status === "rejected"
  ) {
    throw transactions.reason;
  }
  if (transactions.status === "rejected") {
    log.debug("public transaction history unavailable", transactions.reason);
  }
  if (tokenTransfers.status === "rejected") {
    log.debug("public token history unavailable", tokenTransfers.reason);
  }

  const warnings: PublicActivityWarning[] = [];
  let complete = true;
  if (transactions.status === "rejected") {
    complete = false;
    warnings.push("TRANSACTION_HISTORY_UNAVAILABLE");
  } else if (transactions.value.invalid) {
    complete = false;
    warnings.push("TRANSACTION_HISTORY_INVALID");
  } else if (!transactions.value.complete) {
    complete = false;
    warnings.push("TRANSACTION_HISTORY_TRUNCATED");
  }
  if (tokenTransfers.status === "rejected") {
    complete = false;
    warnings.push("TOKEN_TRANSFER_HISTORY_UNAVAILABLE");
  } else if (tokenTransfers.value.invalid) {
    complete = false;
    warnings.push("TOKEN_TRANSFER_HISTORY_INVALID");
  } else if (!tokenTransfers.value.complete) {
    complete = false;
    warnings.push("TOKEN_TRANSFER_HISTORY_TRUNCATED");
  }

  return {
    items: mapPublicActivity(
      network,
      address,
      transactions.status === "fulfilled" ? transactions.value.items : [],
      tokenTransfers.status === "fulfilled"
        ? tokenTransfers.value.items
        : [],
    ),
    complete,
    warnings,
  };
};
