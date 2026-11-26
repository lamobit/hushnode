import assert from "node:assert/strict";
import test from "node:test";
import { classifyRelayError } from "../src/relay-error.js";

test("relay classification recognizes deterministic ethers errors", () => {
  const insufficient = Object.assign(new Error("upstream details"), {
    code: "INSUFFICIENT_FUNDS",
  });
  assert.deepEqual(classifyRelayError(insufficient), {
    status: 422,
    code: "INSUFFICIENT_FUNDS",
    message:
      "The transaction signer does not have enough funds for this transaction.",
  });

  const nonce = {
    info: { error: { message: "nonce has already been used" } },
  };
  assert.equal(classifyRelayError(nonce).code, "NONCE_CONFLICT");
  assert.equal(classifyRelayError(nonce).status, 409);

  const replacement = new Error("replacement transaction underpriced");
  assert.equal(
    classifyRelayError(replacement).code,
    "REPLACEMENT_UNDERPRICED",
  );

  const known = new Error("already known");
  assert.equal(
    classifyRelayError(known).code,
    "TRANSACTION_ALREADY_KNOWN",
  );

  const invalid = Object.assign(new Error("bad bytes"), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(classifyRelayError(invalid).code, "INVALID_TRANSACTION");
});

test("relay classification keeps unknown failures unavailable and sanitized", () => {
  const failure = classifyRelayError(
    new Error("https://secret.example/api-key=super-secret"),
  );
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "RELAY_UNAVAILABLE");
  assert.doesNotMatch(failure.message, /secret|https:/);
});
