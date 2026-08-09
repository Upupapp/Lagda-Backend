// Migration CLI — the explicit deployment step.
//
// Run from a deployment pipeline, never from application startup. If every API
// process migrated on boot, a rolling deploy would have several instances
// racing the same schema change at whatever moment a container happened to
// restart.
//
//   node --experimental-strip-types infra/migrate.ts up
//   node --experimental-strip-types infra/migrate.ts status

import {
  loadDatabaseConfig, createDatabase, migrateToLatest, migrationStatus,
} from "@lagda/db";

const command = process.argv[2] ?? "status";

/**
 * Structured records, matching the API's log conventions.
 *
 * Written directly rather than through Pino: a migration script should not
 * acquire a dependency on the HTTP package to print three lines. The FIELDS are
 * what a log aggregator queries, and they are the same ones the API emits —
 * `service`, `processRole`, `event` — so a failed migration is findable next to
 * the deploy that ran it.
 *
 * The previous version wrote `[migrate] applied 003_x`, which no aggregator can
 * filter on and which is precisely what someone searches for during an incident.
 */

/**
 * A safe rendering of a failure.
 *
 * The message only — never the config object, and never anything that could
 * carry `DATABASE_URL`. A driver error can still embed a connection string in
 * its own message, so credentials are stripped.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, "$1:[redacted]@");
}

function emit(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level: level === "error" ? 50 : 30,
    time: Date.now(),
    service: "lagda-backend",
    processRole: "migration",
    event,
    ...fields,
  });
  // stdout for both, so a deployment pipeline capturing one stream sees the
  // whole sequence in order.
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  // Fails here if DATABASE_URL is missing or malformed, rather than inside an
  // unrelated request later.
  const config = loadDatabaseConfig();
  const database = createDatabase(config);

  // Host and database name only — the URL carries the password.
  emit("info", "migration.started", { target: database.describe(), command });

  try {
    if (command === "up") {
      const outcome = await migrateToLatest(database.db);
      for (const name of outcome.applied) emit("info", "migration.applied", { migration: name });
      if (outcome.error) {
        // Surfaced, never swallowed: deployment must stop rather than start an
        // application against a half-migrated schema.
        emit("error", "migration.failed", { error: describeError(outcome.error) });
        return 1;
      }
      if (outcome.applied.length === 0) emit("info", "migration.up_to_date");
      return 0;
    }

    if (command === "status") {
      const status = await migrationStatus(database.db);
      for (const m of status) {
        emit("info", "migration.status", { migration: m.name, applied: m.applied });
      }
      const pending = status.filter(m => !m.applied).length;
      emit("info", "migration.pending", { pending });
      return 0;
    }

    emit("error", "migration.unknown_command", { command, expected: "up | status" });
    return 2;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
