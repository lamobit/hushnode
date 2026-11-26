import type { Server } from "node:http";

export type CloseHttpServerOptions = {
  drainTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

export const closeHttpServer = (
  server: Server,
  options: CloseHttpServerOptions = {},
): Promise<void> => {
  const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? 8_000);
  return new Promise<void>((resolve) => {
    let finished = false;
    const drainTimeout = setTimeout(() => {
      server.closeAllConnections();
    }, drainTimeoutMs);
    drainTimeout.unref();

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(drainTimeout);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (error && code !== "ERR_SERVER_NOT_RUNNING") options.onError?.(error);
      resolve();
    };

    try {
      server.closeIdleConnections();
      server.close((error) => finish(error));
    } catch (error) {
      server.closeAllConnections();
      finish(error);
    }
  });
};
