// 084 — which optional emails an account wants.
//
// Settings → Notifications showed five switches and kept them in the tab,
// so every one of them was a promise the server did not keep. This stores
// them, per ACCOUNT, and `createNotificationIntent` reads them.
//
// ── Global, not per workspace ──────────────────────────────────────────────
//
// A person asks "stop emailing me when my requests complete", not "…when my
// requests in workspace B complete". One row per account, keyed by the user
// id, shaped like `user_avatars` (072) and `user_signatures` (050): the
// account's own row, owned by the account and by no workspace.
//
// ── No row-level security, like 050 and 072 ────────────────────────────────
//
// The only reader of a row is (a) the account itself, by its SESSION's user
// id — `/me/notification-preferences` has no `:userId`, so no other account
// is expressible — and (b) intent creation, which runs inside the PRODUCER's
// transaction: usually a WORKSPACE-scoped one (a completed request, a join
// request). A `lagda.current_user_id` policy would make every such read
// return nothing, and so would silently turn every preference back ON.
//
// ── Absence means "everything on" ──────────────────────────────────────────
//
// No row is written at registration. An account that never opened the page
// has no row, and every column's default is TRUE, so the insert that the
// first change performs lands the untouched switches on their defaults.
//
// ── No deletes ─────────────────────────────────────────────────────────────
//
// `lagda_app` may OWN this table in production (075's header), and an owner
// holds every privilege by default. Turning a switch back on is an UPDATE;
// nothing needs to remove a row, so the explicit revoke keeps it that way.
// The users FK is therefore RESTRICT rather than CASCADE: a cascade would
// need exactly the DELETE this revokes.
//
// ── The suppression it enables ─────────────────────────────────────────────
//
// An optional notice to an account that switched its category off is still
// CREATED — the fact happened, and the in-app feed may show it — but its
// EMAIL delivery is stopped at once as SUPPRESSED with the new bounded
// failure code `RECIPIENT_PREFERENCE`, through the same `stopPendingDelivery`
// path the other suppression reasons use. The delivery CHECK is widened here.

import { type Kysely, sql } from "kysely";

const FAILURE_CODES_BEFORE = [
  "SECRET_EXPIRED", "SECRET_REVOKED", "SOURCE_CANCELLED", "DESTINATION_INVALID",
] as const;
const FAILURE_CODES_AFTER = [...FAILURE_CODES_BEFORE, "RECIPIENT_PREFERENCE"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setDeliveryFailureCodes(
  db: Kysely<unknown>, codes: readonly string[],
): Promise<void> {
  await sql`
    alter table notification_deliveries
      drop constraint if exists notification_deliveries_failure_code_check
  `.execute(db);
  await sql`
    alter table notification_deliveries
      add constraint notification_deliveries_failure_code_check
        check (failure_code is null or failure_code in (${inList(codes)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_notification_preferences (
      user_id             varchar(64)  primary key references users (user_id),
      signer_activity     boolean      not null default true,
      request_completed   boolean      not null default true,
      action_reminders    boolean      not null default true,
      workspace_requests  boolean      not null default true,
      invitations         boolean      not null default true,
      updated_at          timestamptz  not null
    )
  `.execute(db);

  await sql`
    grant select, insert, update on table user_notification_preferences to lagda_app
  `.execute(db);
  // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
  await sql`
    revoke delete, truncate on table user_notification_preferences from lagda_app
  `.execute(db);

  await setDeliveryFailureCodes(db, FAILURE_CODES_AFTER);
}

/** Fails, deliberately, while any delivery carries `RECIPIENT_PREFERENCE`. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setDeliveryFailureCodes(db, FAILURE_CODES_BEFORE);
  await sql`drop table if exists user_notification_preferences`.execute(db);
}
