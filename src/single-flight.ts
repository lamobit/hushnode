import { abortReason } from "./abort.js";

type Operation<Value> = {
  promise: Promise<Value>;
  controller: AbortController;
  cancellableSubscribers: number;
  pinnedSubscribers: number;
  settled: boolean;
};

/**
 * Shares pending work per key. Cancellable subscribers can detach independently;
 * the shared operation is aborted only after its last subscriber leaves.
 * Completed values and failures are never retained.
 */
export class SingleFlight<K, V> {
  private readonly pending = new Map<K, Operation<V>>();

  run(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) {
      existing.pinnedSubscribers += 1;
      return existing.promise;
    }
    return this.begin(key, load, 1, 0).promise;
  }

  runWithSignal(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    signal?: AbortSignal,
  ): Promise<V> {
    if (!signal) return this.run(key, () => load(new AbortController().signal));
    if (signal.aborted) return Promise.reject(abortReason(signal));

    const existing = this.pending.get(key);
    let operation: Operation<V>;
    if (existing) {
      existing.cancellableSubscribers += 1;
      operation = existing;
    } else {
      operation = this.begin(key, load, 0, 1);
    }

    return new Promise<V>((resolve, reject) => {
      let subscribed = true;
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      const leave = (): boolean => {
        if (!subscribed) return false;
        subscribed = false;
        operation.cancellableSubscribers = Math.max(
          0,
          operation.cancellableSubscribers - 1,
        );
        cleanup();
        return true;
      };
      const onAbort = (): void => {
        if (!leave()) return;
        this.releaseIfUnused(key, operation, abortReason(signal));
        reject(abortReason(signal));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      operation.promise.then(
        (value) => {
          if (!leave()) return;
          resolve(value);
        },
        (error: unknown) => {
          if (!leave()) return;
          reject(error);
        },
      );
    });
  }

  private begin(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    pinnedSubscribers: number,
    cancellableSubscribers: number,
  ): Operation<V> {
    const controller = new AbortController();
    const operation = {
      promise: Promise.resolve().then(() => {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        return load(controller.signal);
      }),
      controller,
      cancellableSubscribers,
      pinnedSubscribers,
      settled: false,
    } satisfies Operation<V>;
    this.pending.set(key, operation);
    operation.promise.then(
      () => this.finish(key, operation),
      () => this.finish(key, operation),
    );
    void operation.promise.catch(() => undefined);
    return operation;
  }

  private finish(key: K, operation: Operation<V>): void {
    operation.settled = true;
    if (this.pending.get(key) === operation) {
      this.pending.delete(key);
    }
  }

  private releaseIfUnused(
    key: K,
    operation: Operation<V>,
    reason: unknown,
  ): void {
    if (
      operation.settled ||
      operation.pinnedSubscribers > 0 ||
      operation.cancellableSubscribers > 0
    ) {
      return;
    }
    if (this.pending.get(key) === operation) {
      this.pending.delete(key);
    }
    operation.controller.abort(reason);
  }
}
