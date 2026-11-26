export const withTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message)),
      Math.max(0, timeoutMs),
    );
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export type CleanupOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

/**
 * Runs cleanup without letting a synchronous throw, rejection, or hung
 * operation escape the caller's shutdown path. The returned outcome keeps
 * failures visible to the owner while guaranteeing that cleanup is bounded.
 */
export const settleCleanup = async (
  operation: () => unknown,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<CleanupOutcome> => {
  try {
    await withTimeout(
      Promise.resolve().then(operation),
      timeoutMs,
      timeoutMessage,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
};

export const settleWithin = async (
  operations: Iterable<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> => {
  const pending = [...operations];
  if (pending.length === 0) return true;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref();
  });
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true as const),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
