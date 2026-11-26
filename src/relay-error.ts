export type RelayFailureCode =
  | "INSUFFICIENT_FUNDS"
  | "NONCE_CONFLICT"
  | "REPLACEMENT_UNDERPRICED"
  | "TRANSACTION_ALREADY_KNOWN"
  | "INVALID_TRANSACTION"
  | "RELAY_UNAVAILABLE";

export type RelayFailure = {
  status: number;
  code: RelayFailureCode;
  message: string;
};

const MAX_HINT_NODES = 32;
const MAX_HINT_DEPTH = 5;
const HINT_KEYS = [
  "code",
  "reason",
  "shortMessage",
  "message",
  "details",
  "error",
  "cause",
  "info",
  "data",
  "body",
] as const;

const collectErrorHints = (error: unknown): string => {
  const hints: string[] = [];
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  while (queue.length > 0 && hints.length < MAX_HINT_NODES) {
    const current = queue.shift()!;
    if (
      current.depth > MAX_HINT_DEPTH ||
      current.value === null ||
      current.value === undefined ||
      seen.has(current.value)
    ) {
      continue;
    }
    if (typeof current.value === "string" || typeof current.value === "number") {
      hints.push(String(current.value));
      continue;
    }
    if (typeof current.value !== "object") continue;
    seen.add(current.value);
    for (const key of HINT_KEYS) {
      let nested: unknown;
      try {
        nested = (current.value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (nested !== undefined) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return hints.join(" ").toLowerCase();
};

const failure = (
  status: number,
  code: RelayFailureCode,
  message: string,
): RelayFailure => ({ status, code, message });

/**
 * Maps only well-known deterministic broadcast failures. Unknown errors stay
 * unavailable so malformed or failed upstreams never look like client faults.
 */
export const classifyRelayError = (error: unknown): RelayFailure => {
  const hints = collectErrorHints(error);
  if (
    hints.includes("insufficient funds") ||
    hints.includes("insufficient_funds") ||
    hints.includes("insufficientfunds")
  ) {
    return failure(
      422,
      "INSUFFICIENT_FUNDS",
      "The transaction signer does not have enough funds for this transaction.",
    );
  }
  if (
    hints.includes("nonce too low") ||
    hints.includes("nonce is too low") ||
    hints.includes("nonce has already been used") ||
    hints.includes("nonce already used") ||
    hints.includes("nonce expired") ||
    hints.includes("nonce_expired") ||
    hints.includes("nonce_too_low") ||
    hints.includes("old nonce")
  ) {
    return failure(
      409,
      "NONCE_CONFLICT",
      "The transaction nonce is stale or conflicts with an existing transaction.",
    );
  }
  if (
    hints.includes("replacement transaction underpriced") ||
    hints.includes("replacement underpriced") ||
    hints.includes("replacement_underpriced") ||
    hints.includes("replacement fee too low")
  ) {
    return failure(
      409,
      "REPLACEMENT_UNDERPRICED",
      "The replacement transaction fee is too low.",
    );
  }
  if (
    hints.includes("already known") ||
    hints.includes("alreadyknown") ||
    hints.includes("known transaction") ||
    hints.includes("already imported")
  ) {
    return failure(
      409,
      "TRANSACTION_ALREADY_KNOWN",
      "The transaction is already known to the network.",
    );
  }
  if (
    hints.includes("invalid transaction") ||
    hints.includes("invalid_transaction") ||
    hints.includes("unsupported transaction type") ||
    hints.includes("transaction type not supported") ||
    hints.includes("intrinsic gas too low") ||
    hints.includes("exceeds block gas limit") ||
    hints.includes("invalid sender") ||
    hints.includes("invalid signature") ||
    hints.includes("invalid_argument")
  ) {
    return failure(
      422,
      "INVALID_TRANSACTION",
      "The transaction was rejected as invalid.",
    );
  }
  return failure(
    503,
    "RELAY_UNAVAILABLE",
    "Transaction relay is temporarily unavailable.",
  );
};
