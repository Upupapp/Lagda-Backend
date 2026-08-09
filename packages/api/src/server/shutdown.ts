// Graceful shutdown.
//
// PM2 and every container orchestrator send SIGTERM and then wait. A process
// that ignores it gets SIGKILL, which drops in-flight requests — including, one
// day, a signature submission the signer believes succeeded.

export interface ShutdownTarget {
  readonly name: string;
  close(): Promise<void>;
}

export interface ShutdownOptions {
  readonly targets: readonly ShutdownTarget[];
  readonly timeoutMs: number;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected so the coordinator is testable without terminating the test run. */
  readonly exit: (code: number) => void;
}

/**
 * Builds an idempotent shutdown function.
 *
 * Idempotency is not decoration: an orchestrator commonly sends SIGTERM and then
 * SIGINT moments later, and two concurrent shutdowns would close the database
 * pool twice — the second throwing during cleanup, which is exactly when a
 * confusing error is least welcome.
 */
export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  const { targets, timeoutMs, log, exit } = options;
  let running: Promise<void> | null = null;

  return function shutdown(): Promise<void> {
    // Second and later calls join the first rather than starting another.
    if (running !== null) return running;

    running = (async () => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Bounded. A close() that never settles must not leave the process
        // hanging until the orchestrator SIGKILLs it.
        log("shutdown timed out; exiting", { timeoutMs });
        exit(1);
      }, timeoutMs);
      // Do not hold the event loop open just for this timer.
      if (typeof timer.unref === "function") timer.unref();

      try {
        // In order: the HTTP server first, so no new work arrives while
        // dependencies are torn down. Closing the pool first would fail
        // in-flight requests that were about to succeed.
        for (const target of targets) {
          try {
            await target.close();
            log("closed", { target: target.name });
          } catch (error) {
            // Keep going. One stuck dependency must not stop the others from
            // releasing their handles.
            log("failed to close cleanly", {
              target: target.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        clearTimeout(timer);
      }

      if (!timedOut) log("shutdown complete");
    })();

    return running;
  };
}
