// A contact's tags (074) — deliberately its own file, separate from
// `contacts.ts`.
//
// A tag SET is replaced wholesale (delete then insert), which is a genuine
// DELETE statement — and the architecture guard
// (`tests/architecture/contacts.test.ts`, "no contact file issues a delete
// statement") asserts `contacts.ts` never contains one, because a CONTACT is
// archived, never deleted. That rule is about the contact RECORD; a tag row
// on a join table is not one, and replacing a tag set is not deleting
// anyone's address-book entry. Splitting the file is what keeps the guard's
// assertion both true and meaningful, rather than narrowing it with an
// exception the next reader has to go find.

import type { Transaction } from "kysely";
import type { WorkspaceId, ContactId } from "@lagda/contracts";
import type { ContactTagId } from "@lagda/application";
import type { Database } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";

export async function replaceContactTags(
  trx: Transaction<Database>,
  scope: WorkspaceId,
  contactId: ContactId,
  tagIds: readonly ContactTagId[],
): Promise<void> {
  try {
    // Replace wholesale: delete then insert, in the caller's transaction. A
    // contact's tag SET is what the caller sent, not a diff against what
    // happened to be there — the same "absolute value, not a patch" rule the
    // rest of this table's writes follow.
    await trx.deleteFrom("contact_tags")
      .where("workspace_id", "=", scope)
      .where("contact_id", "=", contactId)
      .execute();
    if (tagIds.length === 0) return;
    const now = new Date();
    await trx.insertInto("contact_tags").values(
      tagIds.map(tagId => ({
        workspace_id: scope, contact_id: contactId, tag_id: tagId, created_at: now,
      })),
    ).execute();
  } catch (error) {
    throw translatePersistenceError(error);
  }
}
