import type { Request, Response } from "express";

export class RequestAbortedError extends Error {
  constructor() {
    super("The client disconnected before the response completed.");
    this.name = "RequestAbortedError";
  }
}

export type RequestAbortScope = {
  signal: AbortSignal;
  dispose: () => void;
};

/**
 * Tracks the lifetime of one HTTP exchange. The signal aborts only on a
 * premature disconnect, never after a response finishes successfully.
 */
export const createRequestAbortScope = (
  request: Request,
  response: Response,
): RequestAbortScope => {
  const controller = new AbortController();
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    request.off("aborted", abort);
    response.off("close", onClose);
    response.off("error", onError);
    response.off("finish", dispose);
  };
  const abort = (): void => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(new RequestAbortedError());
  };
  const onClose = (): void => {
    if (!response.writableFinished) abort();
    dispose();
  };
  const onError = (): void => {
    abort();
    dispose();
  };

  request.once("aborted", abort);
  response.once("close", onClose);
  response.once("error", onError);
  response.once("finish", dispose);
  if (request.aborted || (response.destroyed && !response.writableFinished)) {
    abort();
  }

  return { signal: controller.signal, dispose };
};
