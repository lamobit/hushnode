import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));

const walkDocs = (directory) => {
  const entries = fs.readdirSync(path.join(root, directory), {
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkDocs(relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
};

const walkTypeScript = (directory) => {
  const entries = fs.readdirSync(path.join(root, directory), {
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScript(relative);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative] : [];
  });
};

const markdownFiles = ["README.md", ...walkDocs("docs")];

for (const file of markdownFiles) {
  const text = read(file);
  const directory = path.dirname(file);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const rawTarget = match[1];
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^(https?:|mailto:)/.test(rawTarget)
    ) {
      continue;
    }
    const target = decodeURI(rawTarget.split("#")[0]);
    if (!target) continue;
    const resolved = path.normalize(path.join(directory, target));
    if (!exists(resolved)) {
      failures.push(`${file}: missing link target ${rawTarget}`);
    }
  }
}

const routeSources = [
  "src/light-api.ts",
  ...walkTypeScript("src/light-api"),
];
const codeRoutes = new Set();
for (const file of routeSources) {
  for (const match of read(file).matchAll(
    /router\.(get|post|delete)\(\s*"([^"]+)"/g,
  )) {
    codeRoutes.add(
      `${match[1].toUpperCase()} /api/light/v1${match[2]}`,
    );
  }
}
const docRoutes = new Set();
for (const match of read("docs/light-api.md").matchAll(
  /^\|\s*`(GET|POST|DELETE)`\s*\|\s*`(\/[^`]*)`\s*\|/gm,
)) {
  docRoutes.add(
    `${match[1]} /api/light/v1${match[2].split("?")[0]}`,
  );
}
if (codeRoutes.size === 0) {
  failures.push("src/light-api.ts: no routes found");
}
for (const route of codeRoutes) {
  if (!docRoutes.has(route)) {
    failures.push(`docs/light-api.md: missing route ${route}`);
  }
}
for (const route of docRoutes) {
  if (!codeRoutes.has(route)) {
    failures.push(`docs/light-api.md: route not found in code ${route}`);
  }
}

const configSources = [
  "src/config.ts",
  "src/logger.ts",
  "src/network.ts",
  "src/networks.ts",
].map(read).join("\n");
const docEnvs = new Set();
for (const match of read("docs/operations.md").matchAll(
  /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm,
)) {
  docEnvs.add(match[1]);
}
for (const env of docEnvs) {
  if (!configSources.includes(env)) {
    failures.push(`docs/operations.md: env ${env} not found in source`);
  }
}

const budgets = {
  "README.md": 120,
  "docs/README.md": 120,
};
for (const [file, budget] of Object.entries(budgets)) {
  const lines = read(file).replace(/\n$/, "").split("\n").length;
  if (lines > budget) {
    failures.push(`${file}: ${lines} lines exceeds budget ${budget}`);
  }
}
for (const file of markdownFiles) {
  const lines = read(file).replace(/\n$/, "").split("\n").length;
  if (lines > 400) {
    failures.push(`${file}: ${lines} lines exceeds 400-line cap`);
  }
}

if (failures.length > 0) {
  console.error("docs check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `docs check ok: ${markdownFiles.length} files, ${codeRoutes.size} routes, ${docEnvs.size} env vars`,
);
