// 080. Makes 079's activity log append-only where the migration role and the
// runtime role are the SAME role.
//
// 079 granted `lagda_app` SELECT and INSERT and assumed that was all it held.
// That is true where another role owns the table (the test database), but a
// deployment that migrates AS `lagda_app` makes it the OWNER, and an owner
// holds every privilege until one is explicitly revoked — so history could be
// edited or deleted there. The same explicit revoke 003 applies to
// evidence_events closes it. Found by inspecting production grants after 079.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    revoke update, delete, truncate on workspace_activity_events from lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores 079's state exactly: nothing was granted, so nothing is re-granted
  // beyond what ownership would have held.
  await sql`
    grant update, delete, truncate on workspace_activity_events to lagda_app
  `.execute(db);
}
