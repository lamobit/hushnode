import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ArtifactStore } from "@railgun-community/wallet";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryWithin,
} from "../private-directory.js";

const MAX_ARTIFACT_PATH_LENGTH = 1_024;

const safeRelativePath = (relative: string): string => {
  if (
    !relative ||
    relative.length > MAX_ARTIFACT_PATH_LENGTH ||
    relative.includes("\0")
  ) {
    throw new Error("Invalid artifact path.");
  }
  const normalized = path.normalize(relative);
  if (
    normalized === "." ||
    normalized.startsWith("..") ||
    path.isAbsolute(normalized)
  ) {
    throw new Error("Invalid artifact path.");
  }
  return normalized;
};

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const targetPath = (root: string, relative: string): string => {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, safeRelativePath(relative));
  if (!isWithin(resolvedRoot, target)) {
    throw new Error("Invalid artifact path.");
  }
  return target;
};

const assertRealDirectoryChain = async (
  root: string,
  target: string,
): Promise<void> => {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Artifact root is not a real directory.");
  }

  const relative = path.relative(resolvedRoot, path.dirname(target));
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Artifact path is not a real directory.");
    }
  }
};

const readArtifact = async (
  root: string,
  relative: string,
): Promise<Buffer> => {
  const target = targetPath(root, relative);
  await assertRealDirectoryChain(root, target);
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
  const handle = await fs.promises.open(target, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Artifact path is not a regular file.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const createArtifactStore = (root: string): ArtifactStore => {
  ensurePrivateDirectory(root);

  const getFile = (relative: string) => readArtifact(root, relative);

  const storeFile = async (
    directory: string,
    relative: string,
    contents: string | Uint8Array,
  ) => {
    const safeDirectory = safeRelativePath(directory);
    const target = targetPath(root, relative);
    ensurePrivateDirectoryWithin(
      root,
      targetPath(root, safeDirectory),
    );
    ensurePrivateDirectoryWithin(root, path.dirname(target));
    const partial = `${target}.${process.pid}.${randomBytes(5).toString("hex")}.partial`;
    try {
      await fs.promises.writeFile(partial, contents, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(partial, target);
    } catch (error) {
      await fs.promises.rm(partial, { force: true });
      throw error;
    }
  };

  const fileExists = async (relative: string): Promise<boolean> => {
    try {
      const target = targetPath(root, relative);
      await assertRealDirectoryChain(root, target);
      const stat = await fs.promises.lstat(target);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  };

  return new ArtifactStore(getFile, storeFile, fileExists);
};
