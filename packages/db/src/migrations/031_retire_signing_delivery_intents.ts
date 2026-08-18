// 031 — the signing invitation moves onto the canonical substrate.
//
// ── Why this is a migration and not a second table ─────────────────────────
//
// `signing_delivery_intents` (migration 020) is a notification intent under
// another name. Every column maps: `grant_id` is the source, `purpose` is the
// type, `recipient_email` is the destination, the four display columns are the
// frozen template input, `sealed_credential` is a SEALED secret reference, and
// `dispatched_at is null` is `PENDING`.
//
// That is not a coincidence to be tidied away — it is the same design,
// discovered once for signing and then generalised. What the generalisation
// adds is a scope discriminant, a frozen template version, and a delivery state
// that can express more than "outstanding" or "handed over".
//
// Leaving both would give LAGDA two delivery paths, and BACKEND-45 would have
// to integrate a provider against one of them while the other kept accumulating
// rows nobody sends.
//
// ── Copy, then drop, in one transaction ────────────────────────────────────
//
// Expand-migrate-contract normally spreads those across releases so a running
// deployment can read both shapes. There is no running deployment: this backend
// has never been deployed and serves no routes. Splitting the contract into a
// later migration would leave a table that no code reads and no operator can
// explain, which is its own hazard.
//
// Logical identity is preserved rather than regenerated (§237). The old
// `delivery_intent_id` becomes the notification intent id, so anything that
// recorded one still resolves. `dispatched_at` decides the state, so a delivery
// already handed to a provider is NOT resurrected as pending and re-sent.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Intents ────────────────────────────────────────────────────────────────
  //
  // `template_version` is 1 for every migrated row: v1 is the only registered
  // signing-invitation template, and it is the copy these rows were written to
  // be rendered with.
  await sql`
    insert into notification_intents (
      notification_intent_id, workspace_id, user_id,
      notification_type, source_kind, source_id,
      audience_kind, audience_user_id, audience_recipient_id,
      audience_invitation_id,
      template_key, template_version, locale, template_input,
      secret_ref_kind, sealed_secret, sealed_key_version, challenge_id,
      created_at
    )
    select
      sdi.delivery_intent_id,
      sdi.workspace_id,
      null,
      'SIGNING_INVITATION',
      'SIGNING_ACCESS_GRANT',
      sdi.grant_id,
      'SIGNING_REQUEST_RECIPIENT',
      null,
      sdi.request_recipient_id,
      null,
      'signing-invitation',
      1,
      'en',
      jsonb_build_object(
        'recipientName',     sdi.recipient_name,
        'documentTitle',     sdi.document_title,
        'senderDisplayName', sdi.sender_display_name,
        'workspaceName',     sdi.workspace_name
      ),
      'SEALED',
      sdi.sealed_credential,
      sdi.sealed_key_version,
      null,
      sdi.created_at
    from signing_delivery_intents sdi
    -- Idempotent: a rerun against a partially migrated database adds nothing.
    on conflict (source_kind, source_id, notification_type) do nothing
  `.execute(db);

  // ── Deliveries ─────────────────────────────────────────────────────────────
  //
  // `dispatched_at` carried two meanings in one nullable column. It maps to
  // PENDING when null, and to PROVIDER_ACCEPTED when set — the honest reading
  // of "BACKEND-45 sets this when a provider accepts it", and deliberately NOT
  // `DELIVERED`, which the old column never claimed and nothing observed.
  //
  // In practice no row has ever been dispatched, because nothing dispatches.
  await sql`
    insert into notification_deliveries (
      notification_delivery_id, notification_intent_id,
      workspace_id, user_id, channel, destination, state, failure_code,
      created_at
    )
    select
      'ndel_' || sdi.delivery_intent_id,
      sdi.delivery_intent_id,
      sdi.workspace_id,
      null,
      'EMAIL',
      sdi.recipient_email,
      case when sdi.dispatched_at is null then 'PENDING' else 'PROVIDER_ACCEPTED' end,
      null,
      sdi.created_at
    from signing_delivery_intents sdi
    on conflict (notification_intent_id, channel) do nothing
  `.execute(db);

  // ── Retire the legacy table ────────────────────────────────────────────────
  //
  // Nothing reads it: the send path now writes notification intents, the
  // repository method is gone, and the Kysely type no longer declares it.
  await sql`drop table if exists signing_delivery_intents`.execute(db);
}

export function down(_db: Kysely<unknown>): Promise<void> {
  // Deliberately not reversible.
  //
  // Recreating the table is easy; deciding which notification rows belonged to
  // it is not, because a later invitation created directly on the substrate is
  // indistinguishable from a migrated one. A `down` that guessed would silently
  // resurrect intents as unsent delivery work.
  //
  // Rolling this back means restoring from a backup, which is the honest
  // answer for a migration that drops a table.
  throw new Error(
    "031 is irreversible: restore from backup rather than reconstructing "
    + "signing_delivery_intents from the notification substrate.",
  );
}
