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

async function main(): Promise<number> {
  // Fails here if DATABASE_URL is missing or malformed, rather than inside an
  // unrelated request later.
  const config = loadDatabaseConfig();
  const database = createDatabase(config);

  // Host and database name only — the URL carries the password.
  console.info(`[migrate] target ${database.describe()}`);

  try {
    if (command === "up") {
      const outcome = await migrateToLatest(database.db);
      for (const name of outcome.applied) console.info(`[migrate] applied ${name}`);
      if (outcome.error) {
        // Surfaced, never swallowed: deployment must stop rather than start an
        // application against a half-migrated schema.
        console.error(`[migrate] FAILED: ${outcome.error.message}`);
        return 1;
      }
      if (outcome.applied.length === 0) console.info("[migrate] already up to date");
      return 0;
    }

    if (command === "status") {
      const status = await migrationStatus(database.db);
      for (const m of status) {
        console.info(`[migrate] ${m.applied ? "applied" : "PENDING"}  ${m.name}`);
      }
      const pending = status.filter(m => !m.applied).length;
      console.info(`[migrate] ${String(pending)} pending`);
      return 0;
    }

    console.error(`[migrate] unknown command "${command}". Use: up | status`);
    return 2;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
