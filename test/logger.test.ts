import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../src/logger.js";

test("log details redact credentials and authentication tokens", () => {
  const credential = "unit-test-credential";
  const apiKey = "api-value";
  const bearerToken = "bearer-value";
  const detail =
    `request https://alice:${credential}@rpc.example/path` +
    `?api_key=${apiKey}&x=1 failed; Authorization: Bearer ${bearerToken}`;

  const redacted = redactSensitiveText(detail);

  assert.equal(redacted.includes("alice"), false);
  assert.equal(redacted.includes(credential), false);
  assert.equal(redacted.includes(apiKey), false);
  assert.equal(redacted.includes(bearerToken), false);
  assert.match(redacted, /https:\/\/\[redacted\]@rpc\.example/);
  assert.match(redacted, /api_key=\[redacted\]&x=1/);
  assert.match(redacted, /Bearer \[redacted\]/);
});

test("log detail redaction leaves ordinary diagnostics intact", () => {
  assert.equal(
    redactSensitiveText("provider timed out after 30000ms"),
    "provider timed out after 30000ms",
  );
});
