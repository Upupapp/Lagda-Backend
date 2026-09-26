// 077 — each "Documents I must sign" entry records the ROLE it was written for.
//
// The inbox has been written for every invited recipient except a viewer
// since 056, so an approver, reviewer, acknowledgment or copy recipient
// already appeared in "I must sign" with nothing to sign. Recording the role
// lets the account's list split in two: signers in "I must sign", everyone
// else in "Others" — which now includes viewers, whose entries are written
// from here on (the in-app "continue" still refuses them; a viewer's access
// remains the emailed link alone, see `beginInAppSigning`).
//
// ── A copy recipient's entry carries no credential ─────────────────────────
//
// A copy recipient is issued no signing credential (they are sent the
// finished document, 073), so their "Others" entry has no grant digest to
// store. The column becomes nullable; the existing shape check already
// passes a NULL. Nothing can continue into a ceremony from such an entry.
//
// ── The backfill ─────────────────────────────────────────────────────────
//
// The role lives on `signing_request_recipients`, which carries FORCE row
// level security keyed on a workspace this migration does not have. FORCE
// binds the table owner too, so the join would see no rows. It is lifted for
// the one UPDATE and restored in the same transaction: nothing else runs in
// between, and a failure rolls both back.

import { type Kysely, sql } from "kysely";

const RECIPIENT_TYPES = [
  "signer", "approver", "reviewer", "acknowledgment-recipient", "viewer", "carbon-copy",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table user_signing_inbox
      add column recipient_type varchar(32),
      add constraint user_signing_inbox_recipient_type_check
        check (recipient_type is null or recipient_type in (${inList(RECIPIENT_TYPES)})),
      alter column grant_credential_digest drop not null
  `.execute(db);

  await sql`alter table signing_request_recipients no force row level security`.execute(db);
  await sql`
    update user_signing_inbox as i
       set recipient_type = r.recipient_type
      from signing_request_recipients as r
     where r.request_recipient_id = i.request_recipient_id
       and r.signing_request_id = i.signing_request_id
       and r.workspace_id = i.workspace_id
  `.execute(db);
  await sql`alter table signing_request_recipients force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Viewer entries did not exist before this migration.
  await sql`
    delete from user_signing_inbox
     where recipient_type = 'viewer' or grant_credential_digest is null
  `.execute(db);
  await sql`
    alter table user_signing_inbox
      drop constraint user_signing_inbox_recipient_type_check,
      drop column recipient_type,
      alter column grant_credential_digest set not null
  `.execute(db);
}
