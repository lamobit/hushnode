export type TtlClock = () => number;

export type TtlCacheOptions<Value> = {
  now?: TtlClock;
  maxBytes?: number;
  sizeOf?: (value: Value) => number;
};

type Entry<Value> = {
  value: Value;
  expiresAt: number;
  bytes: number;
};

/**
 * Bounded in-memory cache with lazy expiry and insertion-order eviction.
 * An optional byte budget prevents a small number of large values from
 * exhausting process memory even when the entry count is within bounds.
 */
export class TtlCache<Key, Value> {
  private readonly entries = new Map<Key, Entry<Value>>();
  private readonly now: TtlClock;
  private readonly maxBytes?: number;
  private readonly sizeOf?: (value: Value) => number;
  private retainedBytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    options: TtlClock | TtlCacheOptions<Value> = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("TtlCache ttlMs must be a positive finite number.");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("TtlCache maxEntries must be a positive integer.");
    }
    const config: TtlCacheOptions<Value> =
      typeof options === "function" ? { now: options } : options;
    this.now = config.now ?? Date.now;
    this.maxBytes = config.maxBytes;
    this.sizeOf = config.sizeOf;
    if (
      this.maxBytes !== undefined &&
      (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
    ) {
      throw new Error("TtlCache maxBytes must be a positive integer.");
    }
    if ((this.maxBytes === undefined) !== (this.sizeOf === undefined)) {
      throw new Error(
        "TtlCache maxBytes and sizeOf must be provided together.",
      );
    }
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  get sizeBytes(): number {
    this.prune();
    return this.retainedBytes;
  }

  get(key: Key): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      return undefined;
    }
    return entry.value;
  }

  set(key: Key, value: Value, ttlMs = this.ttlMs): boolean {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("TtlCache entry ttlMs must be positive.");
    }
    const bytes = this.weigh(value);
    if (this.maxBytes !== undefined && bytes > this.maxBytes) {
      return false;
    }
    this.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
      bytes,
    });
    this.retainedBytes += bytes;
    this.prune();
    while (
      this.entries.size > this.maxEntries ||
      (this.maxBytes !== undefined && this.retainedBytes > this.maxBytes)
    ) {
      this.evictOldest();
    }
    return true;
  }

  delete(key: Key): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.remove(key, entry);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private weigh(value: Value): number {
    if (!this.sizeOf) return 0;
    const bytes = this.sizeOf(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("TtlCache sizeOf must return a non-negative integer.");
    }
    return bytes;
  }

  private remove(key: Key, entry: Entry<Value>): void {
    this.entries.delete(key);
    this.retainedBytes -= entry.bytes;
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next().value;
    if (oldest === undefined) return;
    const entry = this.entries.get(oldest);
    if (entry) this.remove(oldest, entry);
  }
}
