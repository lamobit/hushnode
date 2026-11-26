import { abortReason, throwIfAborted } from "./abort.js";

export const readJsonWithLimit = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> => {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("JSON response limit must be a positive integer.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error("JSON response exceeds the configured size limit.");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("JSON response exceeds the configured size limit.");
    }
    return JSON.parse(text) as unknown;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("JSON response exceeds the configured size limit.");
      }
      chunks.push(value);
    }
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  return JSON.parse(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString(
      "utf8",
    ),
  ) as unknown;
};
