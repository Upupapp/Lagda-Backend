// 089 — the signed-in invitee's inbox: "my invitations".
//
// ── What this adds ──────────────────────────────────────────────────────────
//
//   decline_reason         what the invitee wrote when declining from the
//       inbox (1–500 characters, required there; the emailed link's decline
//       stores none). Only ever present on a DECLINED row — withdrawing the
//       decline clears both.
//   invitee_email_digest   a domain-separated SHA-256 of the normalized
//       address, set by a BEFORE trigger from the address itself (and a CHECK
//       holds it equal), so no writer can supply a wrong one and the realm
//       below matches an index rather than scanning every tenant.
//
// ── How an invitee reaches invitations in other workspaces ─────────────────
//
// The invitee is not a member of the inviting workspace, so tenant context
// cannot find the row. A narrow FOR SELECT realm, shaped exactly like 087's
// sharing-recipient realm: its own setting, `lagda.workspace_invitee`, holding
// the digest of the account's VERIFIED normalized address. Only the invitee
// transaction scope sets it, from the SESSION's account — never from a request
// — and only once the address is verified. Every write (accept, decline,
// withdraw a decline) happens after the transaction enters the RESOLVED
// invitation's workspace, where `tenant_isolation`'s WITH CHECK governs it.
//
// ── Backfill under FORCE ────────────────────────────────────────────────────
//
// Production migrates as `lagda_app`, the table's OWNER, and FORCE row-level
// security applies to the owner too: with no context the digest backfill would
// match zero rows and the NOT NULL after it would fail (088's first production
// run). FORCE is lifted for the backfill only, as 077 and 088 do.
//
// ── Privileges ──────────────────────────────────────────────────────────────
//
// 014 granted SELECT, INSERT, UPDATE and nothing else: an invitation is
// security history and is never deleted. A deployment that migrates as
// `lagda_app` makes it the owner, and an owner holds every privilege until one
// is explicitly revoked (080's lesson), so DELETE and TRUNCATE are revoked here.
//
// ── Vocabularies ────────────────────────────────────────────────────────────
//
//   WORKSPACE_INVITATION_RECEIVED  to the invitee's VERIFIED account, on every
//                                  send and resend. In-app only.
//   WORKSPACE_INVITATION_DECLINED  to the inviter, with the reason. In-app only.
//   WORKSPACE_INVITATION_NOTICE    the source kind: one id per notice, so a
//                                  resend or a second decline is a new notice.
//   invitation.decline_withdrawn   the activity entry for taking a decline back.

import { type Kysely, sql } from "kysely";

const INVITEE_SETTING = "lagda.workspace_invitee";
/** Must match `INVITEE_DIGEST_DOMAIN` in the invitations repository. */
const INVITEE_DIGEST_DOMAIN = "lagda.workspace-invitee:";

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED", "VERIFICATION_ACCESS_CODE",
  "CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
  "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED",
  "DOCUMENT_SHARE_RECEIVED", "DOCUMENT_SHARE_ACCEPTED", "DOCUMENT_SHARE_REJECTED",
  "DOCUMENT_ACCESS_REQUESTED", "DOCUMENT_ACCESS_APPROVED", "DOCUMENT_ACCESS_REJECTED",
  "SHARED_DOCUMENT_ACCESS_CODE",
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE, "WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "WORKSPACE_INVITATION_NOTICE"] as const;

const ACTIONS_BEFORE = [
  "workspace.created", "workspace.renamed",
  "member.role_changed", "member.access_changed", "member.removed",
  "invitation.sent", "invitation.resent", "invitation.revoked",
  "invitation.accepted", "invitation.declined",
  "join_link.created", "join_link.sent", "join_link.withdrawn",
  "join_request.submitted", "join_request.approved", "join_request.declined",
  "team.created", "team.renamed", "team.archived",
  "team.member_added", "team.member_updated", "team.member_removed",
  "workspace.branding_changed",
  "document_share.created", "document_share.updated", "document_share.removed",
  "document_share.accepted", "document_share.rejected", "document_share.rejection_withdrawn",
  "document_share.deleted", "document_share.access_removed",
  "access_request.submitted", "access_request.approved", "access_request.rejected",
  "access_request.rejection_withdrawn", "access_request.deleted", "access_request.access_removed",
] as const;
const ACTIONS_AFTER = [...ACTIONS_BEFORE, "invitation.decline_withdrawn"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

/** The digest of a row's normalized address, as SQL over the column. */
const digestOfColumn = sql`encode(sha256(convert_to(${sql.lit(INVITEE_DIGEST_DOMAIN)} || invitee_normalized_email, 'UTF8')), 'hex')`;

async function setVocabularies(db: Kysely<unknown>, after: boolean): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check,
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(after ? TYPES_AFTER : TYPES_BEFORE)})),
      add constraint notification_intents_source_kind_check
        check (source_kind in (${inList(after ? SOURCES_AFTER : SOURCES_BEFORE)}))
  `.execute(db);
  await sql`
    alter table workspace_activity_events
      drop constraint workspace_activity_events_action_check,
      add constraint workspace_activity_events_action_check
        check (action in (${inList(after ? ACTIONS_AFTER : ACTIONS_BEFORE)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_invitations
      add column decline_reason varchar(500),
      add column invitee_email_digest varchar(64)
  `.execute(db);

  // The owner is subject to FORCE: lift it for the backfill only (see header).
  await sql`alter table workspace_invitations no force row level security`.execute(db);
  await sql`update workspace_invitations set invitee_email_digest = ${digestOfColumn}`.execute(db);
  await sql`alter table workspace_invitations force row level security`.execute(db);

  await sql`
    alter table workspace_invitations
      alter column invitee_email_digest set not null,
      add constraint chk_workspace_invitations_invitee_digest
        check (invitee_email_digest = ${digestOfColumn}),
      add constraint chk_workspace_invitations_decline_reason check (
        decline_reason is null
        or (declined_at is not null and length(btrim(decline_reason)) > 0)
      )
  `.execute(db);
  // Derived by the database on every write of the address, so no writer —
  // the repository, a fixture, a future path — can store a wrong digest.
  await sql`
    create or replace function lagda_workspace_invitee_digest() returns trigger
    language plpgsql
    as $$
    begin
      new.invitee_email_digest := encode(sha256(convert_to(
        ${sql.lit(INVITEE_DIGEST_DOMAIN)} || new.invitee_normalized_email, 'UTF8')), 'hex');
      return new;
    end
    $$
  `.execute(db);
  await sql`
    create trigger trg_workspace_invitations_invitee_digest
      before insert or update of invitee_normalized_email, invitee_email_digest
      on workspace_invitations
      for each row execute function lagda_workspace_invitee_digest()
  `.execute(db);
  await sql`
    create index idx_workspace_invitations_invitee_digest
      on workspace_invitations (invitee_email_digest, created_at desc)
  `.execute(db);

  // ── The invitee realm ────────────────────────────────────────────────────
  await sql`
    create or replace function lagda_current_workspace_invitee() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(INVITEE_SETTING)}, true), '') $$
  `.execute(db);
  await sql`grant execute on function lagda_current_workspace_invitee() to lagda_app`.execute(db);
  await sql`
    create policy invitee_inbox_read on workspace_invitations
    for select
    using (invitee_email_digest = lagda_current_workspace_invitee())
  `.execute(db);

  // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
  await sql`revoke delete, truncate on table workspace_invitations from lagda_app`.execute(db);

  await setVocabularies(db, true);
}

/**
 * Fails, deliberately, while any 089 notification or activity entry exists.
 * DELETE and TRUNCATE are not re-granted: 014 never granted them.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
  await sql`drop policy if exists invitee_inbox_read on workspace_invitations`.execute(db);
  await sql`drop function if exists lagda_current_workspace_invitee()`.execute(db);
  await sql`drop index if exists idx_workspace_invitations_invitee_digest`.execute(db);
  await sql`
    drop trigger if exists trg_workspace_invitations_invitee_digest on workspace_invitations
  `.execute(db);
  await sql`drop function if exists lagda_workspace_invitee_digest()`.execute(db);
  await sql`
    alter table workspace_invitations
      drop constraint if exists chk_workspace_invitations_decline_reason,
      drop constraint if exists chk_workspace_invitations_invitee_digest,
      drop column decline_reason,
      drop column invitee_email_digest
  `.execute(db);
}
