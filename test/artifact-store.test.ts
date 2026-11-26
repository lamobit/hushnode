import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifactStore } from "../src/railgun/artifact-store.js";

const withTempDirectory = async (
  run: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hush-artifact-"));
  try {
    await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("artifact store writes private files and reads them within its root", async () => {
  await withTempDirectory(async (temporary) => {
    const root = path.join(temporary, "artifacts");
    const relative = "artifacts-v2.1/cid/vkey.json";
    const store = createArtifactStore(root);

    await store.store("artifacts-v2.1/cid", relative, "artifact");
    assert.equal(await store.exists(relative), true);
    const contents = await store.get(relative);
    assert.equal(Buffer.from(contents ?? []).toString("utf8"), "artifact");

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(root, relative)).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.join(root, "artifacts-v2.1/cid")).mode & 0o777,
        0o700,
      );
    }

    await assert.rejects(
      store.store("../escape", relative, "artifact"),
      /Invalid artifact path/,
    );
    await assert.rejects(store.get("/etc/passwd"), /Invalid artifact path/);
    assert.equal(await store.exists("../escape"), false);
  });
});

test("artifact store rejects symlinked roots, directories and files", async () => {
  await withTempDirectory(async (temporary) => {
    const outside = path.join(temporary, "outside");
    fs.mkdirSync(outside);

    const linkedRoot = path.join(temporary, "linked-root");
    fs.symlinkSync(outside, linkedRoot, "dir");
    assert.throws(
      () => createArtifactStore(linkedRoot),
      /real directory/,
    );

    const root = path.join(temporary, "artifacts");
    const store = createArtifactStore(root);
    fs.symlinkSync(outside, path.join(root, "linked-directory"), "dir");
    await assert.rejects(
      store.store(
        "linked-directory",
        "linked-directory/vkey.json",
        "artifact",
      ),
      /real directory/,
    );
    assert.equal(fs.existsSync(path.join(outside, "vkey.json")), false);

    const secret = path.join(temporary, "secret");
    fs.writeFileSync(secret, "not an artifact");
    fs.symlinkSync(secret, path.join(root, "linked-file"));
    await assert.rejects(store.get("linked-file"));
    assert.equal(await store.exists("linked-file"), false);
  });
});
