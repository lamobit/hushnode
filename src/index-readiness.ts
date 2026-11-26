export type IndexState = "starting" | "syncing" | "ready" | "degraded";

export type IndexReadiness = {
  ready: boolean;
  state: IndexState;
  retryAttempt: number;
  lastCompletedAt: number | null;
};

export type IndexRuntimeStatus =
  | "idle"
  | "queued"
  | "syncing"
  | "ready"
  | "error";

export const notStartedReadiness = (): IndexReadiness => ({
  ready: false,
  state: "starting",
  retryAttempt: 0,
  lastCompletedAt: null,
});

export const degradedReadiness = (): IndexReadiness => ({
  ready: false,
  state: "degraded",
  retryAttempt: 0,
  lastCompletedAt: null,
});

export const deriveIndexReadiness = (
  runtime: {
    status: IndexRuntimeStatus;
    retryAttempt: number;
    lastCompletedAt?: number;
  },
  health: {
    initialized: boolean;
    running: boolean;
    networkLoaded: boolean;
    stopping: boolean;
  },
): IndexReadiness => {
  const available =
    health.initialized &&
    health.running &&
    health.networkLoaded &&
    !health.stopping;
  const ready = available && runtime.status === "ready";
  let state: IndexState;
  if (ready) {
    state = "ready";
  } else if (
    runtime.status === "error" ||
    health.stopping ||
    (health.initialized && !health.running)
  ) {
    state = "degraded";
  } else if (
    runtime.status === "queued" ||
    runtime.status === "syncing" ||
    (health.running && !health.networkLoaded)
  ) {
    state = "syncing";
  } else {
    state = "starting";
  }
  return {
    ready,
    state,
    retryAttempt: runtime.retryAttempt,
    lastCompletedAt: runtime.lastCompletedAt ?? null,
  };
};
