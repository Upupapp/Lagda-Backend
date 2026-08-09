// The executable. `npm run start:worker` runs this file's compiled output.

import { startWorker } from "./start-worker.js";

startWorker().catch((error: unknown) => {
  // The structured logger may not exist yet — this covers configuration and
  // connectivity failures before the queue is up. A worker that cannot reach
  // its dependencies must exit non-zero rather than idle in a broken state.
  const line = JSON.stringify({
    level: 60,
    time: Date.now(),
    service: "lagda-backend",
    processRole: "worker",
    event: "worker.start_failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(`${line}\n`);
  process.exit(1);
});
