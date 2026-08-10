// Contact persistence.
//
// Two things in here are worth reading closely: how search escapes its pattern,
// and why every mutation is a conditional UPDATE rather than a read followed by
// a write.

import { sql, type Selectable, type Transaction } from "kysely";
import type { ContactId, WorkspaceId } from "@lagda/contracts";
import type {
  ScopedContactRepository, ContactRecord, NewContact,
  ContactListQuery, ContactPage, ContactUpdate,
} from "@lagda/application";
import type { ContactEmailKey } from "@lagda/core";
import type { ContactsTable, Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type ContactRow = Selectable<ContactsTable>;

function toRecord(row: ContactRow): ContactRecord {
  // Re-asserted rather than cast. The column has a CHECK that it is lower case,
  // and this is the boundary that would notice if it somehow were not.
  if (row.normalized_contact_email !== row.normalized_contact_email.toLocaleLowerCase("en-US")) {
    throw new PersistenceMappingError(
      "contacts", "normalized_contact_email",
      "stored comparison key is not folded.",
    );
  }
  return {
    contactId: row.contact_id as ContactId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name,
    email: row.email,
    emailKey: row.normalized_contact_email as ContactEmailKey,
    phone: row.phone,
    organization: row.organization,
    title: row.title,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    archivedAt: row.archived_at === null ? null : row.archived_at.getTime(),
  };
}

/**
 * Escapes a user's search text so it is matched LITERALLY.
 *
 * `%`, `_` and the escape character itself are the three that matter. Without
 * this, a search for `%` matches every contact in the workspace and a search
 * for `_` matches every one-character difference — a caller who typed a
 * punctuation mark gets a result set that looks like a bug, and a caller who
 * did it on purpose gets a cheap way to make the database scan everything.
 *
 * Note what this is NOT: it is not SQL-injection defence. The value is a bound
 * parameter and was never interpolated. This is pattern escaping inside an
 * already-safe parameter, which is a different and less famous problem.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, match => `\\${match}`);
}

const SORT_COLUMNS = {
  name: "name",
  organization: "organization",
  updatedAt: "updated_at",
} as const;

export function createScopedContactRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedContactRepository {
  const scoped = () =>
    trx.selectFrom("contacts").where("workspace_id", "=", scope);

  return {
    async insert(contact: NewContact): Promise<void> {
      if (contact.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("Contact", scope, contact.workspaceId);
      }
      try {
        // Every column named. A spread would carry along any property the
        // record gained later, including computed ones with no column.
        await trx.insertInto("contacts").values({
          contact_id: contact.contactId,
          workspace_id: contact.workspaceId,
          name: contact.name,
          email: contact.email,
          normalized_contact_email: contact.emailKey,
          phone: contact.phone,
          organization: contact.organization,
          title: contact.title,
          created_at: new Date(contact.createdAt),
          // Equal to `created_at` on insert, not null. "Never edited" and
          // "edited at time T" are both answered by one column this way, and a
          // nullable `updated_at` would make the default sort put new contacts
          // in an undefined position.
          updated_at: new Date(contact.createdAt),
          archived_at: null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async findById(contactId: ContactId) {
      const row = await scoped()
        .selectAll()
        .where("contact_id", "=", contactId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list(query: ContactListQuery): Promise<ContactPage> {
      // Built once and reused by both the page query and the count, so the two
      // can never apply different filters — a count that disagrees with its
      // page produces pagination that runs off the end or stops early.
      const filtered = <T extends ReturnType<typeof scoped>>(builder: T) => {
        let next = query.state === "active"
          ? builder.where("archived_at", "is", null)
          : builder.where("archived_at", "is not", null);

        if (query.search !== null) {
          const pattern = `%${escapeLikePattern(query.search)}%`;
          // Four fields, matching what the product's search box searches.
          // ILIKE, so a search for `ayala` finds `Ayala Land`.
          next = next.where(eb => eb.or([
            eb("name", "ilike", pattern),
            eb("email", "ilike", pattern),
            eb("organization", "ilike", pattern),
            eb("title", "ilike", pattern),
          ]));
        }
        return next;
      };

      const column = SORT_COLUMNS[query.sort];

      const rows = await filtered(scoped())
        .selectAll()
        // NULLS LAST in both directions. `organization` is nullable, and the
        // default PostgreSQL behaviour puts nulls first on DESC — so reversing
        // the sort would fill the top of the page with contacts that have no
        // organization, which reads as broken rather than as sorted.
        //
        // The modifier CALLBACK, not `sql.raw(\`${direction} nulls last\`)`.
        // The raw form is deprecated in Kysely 0.28 and, more to the point,
        // interpolates a direction into SQL — safe here because the value comes
        // from a closed union, and a shape not worth leaving for someone to
        // copy somewhere the value is not.
        .orderBy(
          sql.ref(column),
          ob => (query.direction === "asc" ? ob.asc() : ob.desc()).nullsLast(),
        )
        // A tie-breaker, always. Without it two contacts with the same name
        // have an unspecified relative order, and PostgreSQL is free to return
        // them differently on page 1 and page 2 — which silently drops rows
        // from a paginated listing and duplicates others.
        .orderBy("contact_id", "asc")
        .offset(query.offset)
        .limit(query.limit)
        .execute();

      const counted = await filtered(scoped())
        .select(eb => eb.fn.countAll<string>().as("total"))
        .executeTakeFirstOrThrow();

      return { items: rows.map(toRecord), total: Number(counted.total) };
    },

    async findDuplicateCandidates(input) {
      let builder = scoped()
        .selectAll()
        .where("normalized_contact_email", "=", input.emailKey)
        // Active only. A warning about a contact somebody archived last year is
        // noise about a record that is not in the address book.
        .where("archived_at", "is", null);

      if (input.excludeContactId !== null) {
        builder = builder.where("contact_id", "!=", input.excludeContactId);
      }
      const rows = await builder
        .orderBy("created_at", "asc")
        .orderBy("contact_id", "asc")
        .execute();
      return rows.map(toRecord);
    },

    async updateIfActive(input) {
      // Only the keys the caller actually supplied. Assigning `undefined`
      // wholesale would have Kysely write NULL over columns nobody asked to
      // change — the difference between "leave it" and "clear it" is the whole
      // reason `ContactUpdate` distinguishes an absent key from an explicit
      // null, and it would be lost right here.
      const patch: ContactUpdate = input.patch;
      const values: Record<string, unknown> = { updated_at: new Date(input.now) };
      if (patch.name !== undefined) values["name"] = patch.name;
      if (patch.email !== undefined) values["email"] = patch.email;
      if (patch.emailKey !== undefined) {
        values["normalized_contact_email"] = patch.emailKey;
      }
      if (patch.phone !== undefined) values["phone"] = patch.phone;
      if (patch.organization !== undefined) values["organization"] = patch.organization;
      if (patch.title !== undefined) values["title"] = patch.title;

      try {
        const result = await trx.updateTable("contacts")
          .set(values)
          .where("workspace_id", "=", scope)
          .where("contact_id", "=", input.contactId)
          .where("archived_at", "is", null)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async archiveIfActive(input) {
      const result = await trx.updateTable("contacts")
        .set({ archived_at: new Date(input.now), updated_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("contact_id", "=", input.contactId)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async restoreIfArchived(input) {
      const result = await trx.updateTable("contacts")
        .set({ archived_at: null, updated_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("contact_id", "=", input.contactId)
        .where("archived_at", "is not", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
