// 038 — retire the account-login OTP notification type.
//
// ── Why a type is being removed rather than left alone ─────────────────────
//
// `MFA_OTP` was declared by BACKEND-44 for a message the product does not send.
// BACKEND-16's own product inventory had already established why, and BACKEND-45
// missed it: **there is no email-OTP login flow anywhere in the product.** The
// account factor is TOTP, computed from a shared secret, never issued and never
// delivered — so there is no code to put in an email and no challenge record to
// point a notification at.
//
// The "Email OTP" the product advertises is SIGNER authentication: proving an
// external recipient controls an address before they may sign. Different
// subject, different audience, different scope. If that is ever built it gets
// its own notification type rather than borrowing this one, because a type whose
// audience is `USER` cannot describe a message addressed to a recipient.
//
// ── Why it is safe to narrow the constraint ────────────────────────────────
//
// Nothing has ever produced one. The type had no producer, its policy pointed at
// a `CHALLENGE` credential no table could hold, and the delivery path that would
// have carried it was only built in BACKEND-45. A row cannot exist, and the
// backfill below proves it rather than assuming it: the migration fails loudly
// if one does.
//
// ── The rule this serves ───────────────────────────────────────────────────
//
// A vocabulary that declares more than the product sends is a vocabulary that
// invites somebody to implement the difference. BACKEND-44 declared nine
// delivery states in advance deliberately and correctly — those are STATES a
// provider will produce. A notification TYPE with no producer is the opposite:
// not a fixed meaning waiting for a transport, but a promise nobody made.

import { type Kysely, sql } from "kysely";

const REMAINING_TYPES = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET",
  "WORKSPACE_INVITATION", "SIGNING_INVITATION",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // Proof, not assumption. If a row exists the premise is wrong and the
  // migration must stop rather than narrow a constraint out from under it.
  const existing = await sql<{ count: string }>`
    select count(*)::text as count
      from notification_intents
     where notification_type = 'MFA_OTP'
  `.execute(db);

  const count = Number(existing.rows[0]?.count ?? "0");
  if (count > 0) {
    throw new Error(
      `Refusing to retire MFA_OTP: ${String(count)} notification_intents rows `
      + "carry it. The premise that nothing ever produced one is false, and the "
      + "removal needs a data decision before a schema one.");
  }

  await sql`
    alter table notification_intents
      drop constraint notification_intents_type_check
  `.execute(db);

  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(REMAINING_TYPES)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint notification_intents_type_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList([...REMAINING_TYPES, "MFA_OTP"])}))
  `.execute(db);
}
