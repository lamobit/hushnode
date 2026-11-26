type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const minimum =
  configured === "debug"
    ? LEVEL_WEIGHT.debug
    : configured === "warn"
      ? LEVEL_WEIGHT.warn
      : configured === "error"
        ? LEVEL_WEIGHT.error
        : LEVEL_WEIGHT.info;

const REDACTED = "[redacted]";

export const redactSensitiveText = (text: string): string =>
  text
    .replace(
      /\b((?:https?|wss?):\/\/)[^/\s@]+@/gi,
      `$1${REDACTED}@`,
    )
    .replace(
      /([?&](?:api[-_]?key|apikey|access[-_]?token|auth|key|secret|token)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z\d._~+/=-]+/gi, `Bearer ${REDACTED}`);

const describe = (error: unknown): string => {
  const description =
    error instanceof Error
      ? process.env.LOG_LEVEL === "debug"
        ? (error.stack ?? error.message)
        : error.message
      : String(error);
  return redactSensitiveText(description);
};

const write = (level: Level, scope: string, message: string, detail?: unknown) => {
  if (LEVEL_WEIGHT[level] < minimum) return;
  const timestamp = new Date().toISOString();
  const suffix = detail === undefined ? "" : ` ${describe(detail)}`;
  const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export type Logger = {
  debug: (message: string, detail?: unknown) => void;
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, detail?: unknown) => void;
};

export const createLogger = (scope: string): Logger => ({
  debug: (message, detail) => write("debug", scope, message, detail),
  info: (message, detail) => write("info", scope, message, detail),
  warn: (message, detail) => write("warn", scope, message, detail),
  error: (message, detail) => write("error", scope, message, detail),
});
