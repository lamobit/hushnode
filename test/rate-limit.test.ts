import assert from "node:assert/strict";
import test from "node:test";
import { SlidingWindowRateLimiter } from "../src/rate-limit.js";

test("sliding limits keep the strict cutoff, isolate clients and ignore denied hits", () => {
  const limiter = new SlidingWindowRateLimiter(2, 100, 4);
  assert.equal(limiter.allow("a", 0), true);
  assert.equal(limiter.allow("a", 20), true);
  assert.equal(limiter.allow("a", 99), false);
  assert.equal(limiter.allow("b", 99), true);
  assert.equal(limiter.allow("a", 100), true);
  assert.equal(limiter.allow("a", 119), false);
  assert.equal(limiter.allow("a", 120), true);
  limiter.clear();
  assert.equal(limiter.allow("a", 120), true);
});

test("cleanup removes expired clients without resetting active windows", () => {
  const limiter = new SlidingWindowRateLimiter(1, 100, 2);
  assert.equal(limiter.allow("expired", 0), true);
  assert.equal(limiter.allow("active", 90), true);
  assert.equal(limiter.allow("new", 100), true);
  assert.equal(limiter.allow("active", 100), false);
  assert.equal(limiter.allow("expired", 100), true);
  assert.equal(limiter.allow("new", 100), false);
});

test("client buckets stay bounded under source-address churn", () => {
  const limiter = new SlidingWindowRateLimiter(1, 100, 2, 2);
  assert.equal(limiter.allow("a", 0), true);
  assert.equal(limiter.allow("b", 0), true);
  assert.equal(limiter.allow("c", 0), true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allow("a", 0), true);
  assert.equal(limiter.size, 2);
});

test("rate limiter rejects invalid bounds", () => {
  assert.throws(() => new SlidingWindowRateLimiter(0, 100, 2));
  assert.throws(() => new SlidingWindowRateLimiter(1, 0, 2));
  assert.throws(() => new SlidingWindowRateLimiter(1, 100, 0));
  assert.throws(() => new SlidingWindowRateLimiter(1, 100, 2, 1));
});
