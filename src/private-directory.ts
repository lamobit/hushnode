import fs from "node:fs";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Creates or repairs a private directory. Symlinks are rejected so a
 * pre-created path cannot redirect private state outside the data directory.
 */
export const ensurePrivateDirectory = (
  directory: string,
  mode = PRIVATE_DIRECTORY_MODE,
): void => {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Private data path is not a real directory: ${directory}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== mode) {
    fs.chmodSync(directory, mode);
  }
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

/**
 * Creates a private directory below an already-trusted root without following
 * symlinks in any path segment.
 */
export const ensurePrivateDirectoryWithin = (
  root: string,
  directory: string,
  mode = PRIVATE_DIRECTORY_MODE,
): void => {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!isWithin(resolvedRoot, resolvedDirectory)) {
    throw new Error("Private data path escapes its configured root.");
  }

  ensurePrivateDirectory(resolvedRoot, mode);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (!relative) return;

  let current = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Private data path is not a real directory: ${current}`,
      );
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== mode) {
      fs.chmodSync(current, mode);
    }
  }
};
