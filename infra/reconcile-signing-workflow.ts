// Applies outstanding signing-workflow advances, once.
//
//   npm run signing:reconcile
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// A recipient's decline or signature records an advance intent, and the
// workspace-side advance turns it into the REQUEST's state (declined,
// partially-completed, next signer activated). A signature has always run
// that advance straight after committing; until the fix beside this script, a
// decline did not -- and `reconcileSigningWorkflow`, which applies any intent
// left outstanding, had no caller. So declined requests stayed "sent".
//
// Declines now advance immediately. This script applies the intents that
// piled up before that, using the system's own reconciler and the same
// dependencies the decline route composes -- it changes nothing the product
// would not have changed itself had the advance run at the time. Idempotent:
// a second run finds nothing outstanding.
//
// ── Why a script and not a schedule ──────────────────────────────────────────
//
// A recurring sweep belongs in the worker, and the worker cannot compose the
// advance yet: activating a sequential signer provisions a credential, and
// those factories live in the API package, which the worker must not import.
// Moving them to @lagda/security is the prerequisite for a schedule.

import { createDatabase, loadDatabaseConfig } from "@lagda/db";
import { reconcileSigningWorkflow } from "@lagda/application";
import { createProductionDependencies, loadApiConfig } from "@lagda/api";

function emit(level: "info" | "error", event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    level: level === "error" ? 50 : 30, time: Date.now(),
    service: "lagda-backend", processRole: "operator", event, ...fields,
  })}\n`);
}

async function main(): Promise<number> {
  const config = loadApiConfig();
  const database = createDatabase(loadDatabaseConfig());
  try {
    const dependencies = await createProductionDependencies(database, config, undefined);
    const decline = dependencies.signingDecline?.();
    if (decline === undefined) {
      emit("error", "signing_reconcile.unavailable", {
        reason: "signing delivery is not configured in this environment",
      });
      return 1;
    }
    const result = await reconcileSigningWorkflow({
      ...decline,
      policy: { batchSize: 500, maxAttempts: 10 },
    });
    // Counts only. No ids, no titles, no addresses.
    emit("info", "signing_reconcile.completed", { ...result });
    return result.failed === 0 ? 0 : 1;
  } finally {
    await database.close();
  }
}

main().then(code => { process.exitCode = code; }, (error: unknown) => {
  emit("error", "signing_reconcile.failed", {
    message: error instanceof Error ? error.name : "unknown",
  });
  process.exitCode = 1;
});
