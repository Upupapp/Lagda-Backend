// The executable. `npm run start:api` runs this file's compiled output.
//
// Kept to a few lines on purpose: everything testable lives in `startServer()`,
// and a module whose logic runs only as a process entry point is a module
// nothing can test.

import { startServer } from "./start-server.js";

startServer().catch((error: unknown) => {
  // The logger may not exist yet — this catch covers configuration and
  // connectivity failures that happen before Fastify is built. stderr is the
  // only channel guaranteed to work, and a failed start must be visible.
  const line = JSON.stringify({
    level: "fatal",
    msg: "API failed to start",
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(line + "\n");
  process.exit(1);
});
