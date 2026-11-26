/** Sliding-window accounting shared by the API's independent rate limits. */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;
  private readonly cleanupIntervalMs: number;
  private lastCleanupAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly cleanupThreshold: number,
    maxKeys = Math.max(1_024, cleanupThreshold * 4),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Rate limiter limit must be a positive integer.");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("Rate limiter windowMs must be positive.");
    }
    if (
      !Number.isSafeInteger(cleanupThreshold) ||
      cleanupThreshold < 1
    ) {
      throw new Error(
        "Rate limiter cleanupThreshold must be a positive integer.",
      );
    }
    if (
      !Number.isSafeInteger(maxKeys) ||
      maxKeys < cleanupThreshold
    ) {
      throw new Error(
        "Rate limiter maxKeys must be an integer at least as large as cleanupThreshold.",
      );
    }
    this.maxKeys = maxKeys;
    this.cleanupIntervalMs = Math.max(1, Math.floor(windowMs / 4));
  }

  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.cleanup(now, cutoff);
    let recent = this.hits.get(key);
    if (!recent) {
      if (this.hits.size >= this.maxKeys) this.evictOldest();
      recent = [];
    } else {
      this.hits.delete(key);
    }
    this.hits.set(key, recent);
    this.prune(recent, cutoff);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    return true;
  }

  clear(): void {
    this.hits.clear();
    this.lastCleanupAt = Number.NEGATIVE_INFINITY;
  }

  private cleanup(now: number, cutoff: number): void {
    if (this.hits.size <= this.cleanupThreshold) return;
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    for (const [key, timestamps] of this.hits) {
      this.prune(timestamps, cutoff);
      if (timestamps.length === 0) this.hits.delete(key);
    }
  }

  private evictOldest(): void {
    const oldest = this.hits.keys().next().value;
    if (oldest !== undefined) this.hits.delete(oldest);
  }

  private prune(timestamps: number[], cutoff: number): void {
    let count = 0;
    for (const timestamp of timestamps) {
      if (timestamp > cutoff) timestamps[count++] = timestamp;
    }
    timestamps.length = count;
  }
}
