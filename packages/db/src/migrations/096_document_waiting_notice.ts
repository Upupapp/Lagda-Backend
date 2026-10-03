// 096. DOCUMENT_WAITING_FOR_SIGNATURE: the in-app side of a signing invitation.
//
// The invitation email goes to an ADDRESS. The account that holds that address
// (at send time, or when it is created and verified later) had nothing in-app
// to tell it a document was waiting; it found out only by opening "Needs your
// signature". This vocabulary change lets a notice say so. No table: the
// notice is an ordinary intent, in-app only, keyed on the inbox entry's
// recipient so it is written once however many paths could write it.

import { type Kysely, sql } from "kysely";

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
  "WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED",
  "CONTACT_CONNECTION_REQUESTED", "CONTACT_CONNECTION_ACCEPTED",
  "PLAN_UPGRADE_REQUESTED", "PLAN_UPGRADE_APPROVED", "PLAN_UPGRADE_DECLINED",
  "PUBLIC_INQUIRY_RECEIVED",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "DOCUMENT_WAITING_FOR_SIGNATURE"] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
  "WORKSPACE_INVITATION_NOTICE", "CONTACT_CONNECTION", "PLAN_UPGRADE_REQUEST",
  "PUBLIC_INQUIRY",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "SIGNING_INBOX_ENTRY"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

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
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, true);
}

/** Fails, deliberately, while any 096 notice exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
}
