export const mapWithConcurrency = async <T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive integer.");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, async () => worker()),
  );
  return results;
};
