import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryWithin,
} from "../src/private-directory.js";

const withTempDirectory = async (
  run: (directory: string) => void,
): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hush-private-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("private directories are created and repaired to mode 0700", async () => {
  if (process.platform === "win32") return;
  await withTempDirectory((temporary) => {
    const privateDirectory = path.join(temporary, "nested", "data");
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o755 });
    fs.chmodSync(privateDirectory, 0o755);
    ensurePrivateDirectory(privateDirectory);
    assert.equal(fs.statSync(privateDirectory).mode & 0o777, 0o700);
  });
});

test("private directory setup rejects files and symlinks", async () => {
  await withTempDirectory((temporary) => {
    const file = path.join(temporary, "file");
    fs.writeFileSync(file, "not a directory");
    assert.throws(() => ensurePrivateDirectory(file));

    const target = path.join(temporary, "target");
    fs.mkdirSync(target);
    const link = path.join(temporary, "link");
    fs.symlinkSync(target, link, "dir");
    assert.throws(() => ensurePrivateDirectory(link), /real directory/);
  });
});

test("nested private directories stay below their root", async () => {
  await withTempDirectory((temporary) => {
    const root = path.join(temporary, "root");
    const nested = path.join(root, "one", "two");
    ensurePrivateDirectoryWithin(root, nested);
    assert.equal(fs.lstatSync(nested).isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
    }

    assert.throws(
      () =>
        ensurePrivateDirectoryWithin(
          root,
          path.join(root, "..", "outside"),
        ),
      /escapes/,
    );

    const outside = path.join(temporary, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    assert.throws(
      () => ensurePrivateDirectoryWithin(root, path.join(root, "linked")),
      /real directory/,
    );
  });
});
