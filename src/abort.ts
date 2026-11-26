const fallbackAbortReason = (): Error =>
  new DOMException("This operation was aborted.", "AbortError");

export const abortReason = (signal?: AbortSignal): unknown =>
  signal?.reason ?? fallbackAbortReason();

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

/**
 * Stops waiting for a promise when the caller's signal aborts. The promise
 * keeps rejection handlers attached, so abandoned work cannot become an
 * unhandled rejection.
 */
export const raceWithAbort = async <Value>(
  promise: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  if (!signal) return await promise;
  throwIfAborted(signal);
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

/**
 * Propagates an upstream abort into an operation-owned controller.
 * Returns an idempotent cleanup function.
 */
export const forwardAbort = (
  source: AbortSignal | undefined,
  target: AbortController,
): (() => void) => {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(abortReason(source));
    return () => undefined;
  }
  const onAbort = (): void => target.abort(abortReason(source));
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
};
