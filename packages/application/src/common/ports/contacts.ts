// Contact persistence ports (BACKEND-28).
//
// ── One access path, and that is the whole story ───────────────────────────
//
// Unlike invitations, contacts have NO credential lookup and NO user-scoped
// read. Every caller is an authenticated member of the workspace, so the
// ordinary scoped repository is sufficient — and anything narrower would be a
// second access path with nothing asking for it.
//
// ── The methods that are deliberately absent ───────────────────────────────
//
//   delete()            The product archives and restores. It has no delete
//                       action, the runtime role has no DELETE grant on the
//                       table, and adding the method here would be the first
//                       step toward erasing a record a signed document's
//                       recipient snapshot was taken from.
//
//   findByEmail()       as a SINGLE-record lookup. There is no unique
//                       constraint on a contact address — shared inboxes are
//                       legitimately several contacts — so a method returning
//                       one row would have to pick arbitrarily among them.
//                       `findDuplicateCandidates` returns all of them, which is
//                       the honest shape.
//
//   linkToUser()        A contact is never connected to an account. See
//                       CONTACT_IDENTITY.md.

import type { ContactId, WorkspaceId, ContactSortField } from "@lagda/contracts";
import type { ContactEmailKey } from "@lagda/core";

/**
 * A persisted contact.
 *
 * Two email fields, and both are needed. `email` is what gets displayed —
 * exactly what the user typed. `emailKey` is the folded comparison value and is
 * for duplicate detection and exact-match search ONLY; it never leaves the
 * backend, because a client that received it would eventually compare it to
 * something.
 */
export const CONTACT_SCOPES = ["personal", "workspace"] as const;
export type ContactScope = (typeof CONTACT_SCOPES)[number];

/** Mirrors the frontend's `SYSTEM_CONTACT_TAGS` ids exactly (074's CHECK). */
export const CONTACT_TAG_IDS = [
  "tag-client", "tag-vendor", "tag-internal", "tag-legal", "tag-hr",
  "tag-finance", "tag-approver", "tag-reviewer", "tag-signer", "tag-ack",
  "tag-procurement",
] as const;
export type ContactTagId = (typeof CONTACT_TAG_IDS)[number];

export interface ContactRecord {
  readonly contactId: ContactId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly email: string;
  readonly emailKey: ContactEmailKey;
  readonly phone: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
  /**
   * 074. Optional so every pre-074 test fixture across the codebase — most of
   * which build a `ContactRecord` purely as unrelated supporting data (a
   * recipient's source contact, say) — keeps compiling unmodified. The real
   * repository never omits these; only a hand-built literal in a test does,
   * and `scope: "workspace"` is the correct read of "this field was not
   * mentioned" for every one of those.
   */
  readonly scope?: ContactScope;
  /** 074. Set exactly when `scope` is `personal`. */
  readonly ownerUserId?: string | null;
  /** 074. An internal note — never shown to the contact themselves. */
  readonly note?: string | null;
  /** 074. The product's fixed tag ids this contact carries. */
  readonly tagIds?: readonly ContactTagId[];
}

export interface NewContact {
  readonly contactId: ContactId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly email: string;
  readonly emailKey: ContactEmailKey;
  readonly phone: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  /** 074. Optional — see the same note on `ContactRecord`. Defaults to
   *  `"workspace"` / no owner / no note / no tags when omitted. */
  readonly scope?: ContactScope;
  readonly ownerUserId?: string | null;
  readonly note?: string | null;
  readonly tagIds?: readonly ContactTagId[];
}

/**
 * The fields an update may change. Every one of them explicitly named.
 *
 * NOT `Partial<ContactRecord>`. That shape would let a caller pass
 * `{ workspaceId }` and move a contact between tenants, or `{ createdAt }` and
 * rewrite history — the mass-assignment hazard INV-306 banned on accounts and
 * INV-33x banned on workspaces, for exactly the same reason.
 *
 * `phone`, `organization` and `title` accept `null` to CLEAR the field. An
 * absent key means "leave unchanged"; `null` means "remove it". Two distinct
 * intentions, and collapsing them would make clearing a phone number
 * impossible.
 */
export interface ContactUpdate {
  readonly name?: string;
  readonly email?: string;
  readonly emailKey?: ContactEmailKey;
  readonly phone?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  /**
   * Changing scope after creation is deliberately NOT here. Moving a contact
   * between "only I see this" and "the whole workspace sees this" is a
   * one-way-feeling decision a product owner never asked for a form to make
   * casually. Re-adding it with the desired scope is the supported path.
   */
  readonly note?: string | null;
  /** Absent means "leave unchanged"; present REPLACES the whole set. */
  readonly tagIds?: readonly ContactTagId[];
}

/**
 * What a caller may filter and order a listing by.
 *
 * `search` is free text. `state` selects the active book or the archive —
 * never both, because a combined list would silently offer archived contacts
 * as selectable recipients.
 */
export interface ContactListQuery {
  readonly search: string | null;
  readonly state: "active" | "archived";
  readonly sort: ContactSortField;
  readonly direction: "asc" | "desc";
  readonly offset: number;
  readonly limit: number;
  /**
   * 074. Every workspace-scoped contact, plus the personal ones owned by
   * THIS caller — never another member's. See the migration header for why
   * this is a query parameter and not an RLS policy.
   *
   * Optional for the same reason as `ContactRecord`'s new fields: every
   * pre-074 call site keeps compiling, and omitting it means "workspace-scoped
   * rows only" — exactly the pre-074 behaviour, and the correct reading of "no
   * caller was named."
   */
  readonly callerUserId?: string;
}

export interface ContactPage {
  readonly items: readonly ContactRecord[];
  /**
   * The total matching the FILTER, not the page.
   *
   * Counted in the same transaction as the page, so the two cannot describe
   * different states of the table.
   */
  readonly total: number;
}

/**
 * Contact persistence, bound to ONE workspace and ONE transaction.
 *
 * No method takes a workspace argument. The scope is not a parameter, so
 * "read another tenant's address book" is not a call that can be written — and
 * RLS refuses it independently if one ever were.
 */
export interface ScopedContactRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(contact: NewContact): Promise<void>;

  /**
   * Replaces a contact's tag set. Called from within the same update as the
   * rest of the patch, never on its own — a contact's tags are part of its
   * record, not a separate resource with its own lifecycle.
   */
  setTags(input: {
    readonly contactId: ContactId;
    readonly tagIds: readonly ContactTagId[];
  }): Promise<void>;

  /**
   * One contact by id, or null.
   *
   * A contact in another workspace is indistinguishable from one that does not
   * exist. Any difference in the response would confirm it exists elsewhere.
   */
  findById(contactId: ContactId): Promise<ContactRecord | null>;

  /** A filtered, sorted, paginated page plus its total. */
  list(query: ContactListQuery): Promise<ContactPage>;

  /**
   * Every ACTIVE contact sharing an email key.
   *
   * The duplicate-detection primitive, and it returns a LIST because there is
   * no unique constraint to make it a single row. Archived contacts are
   * excluded: warning that a new contact duplicates one somebody archived last
   * year is noise about a record that is not in the address book.
   *
   * `excludeContactId` lets an update ask "does this collide with anything
   * OTHER than itself", which is the question an edit actually has.
   */
  findDuplicateCandidates(input: {
    readonly emailKey: ContactEmailKey;
    readonly excludeContactId: ContactId | null;
  }): Promise<readonly ContactRecord[]>;

  /**
   * Applies an update, conditionally on the contact still being unarchived.
   *
   * Conditional rather than read-then-write for the same reason every other
   * mutation in this codebase is: two concurrent requests both observing an
   * active contact would both write, and one would silently resurrect a record
   * the other archived.
   *
   * Returns whether it applied. Zero rows is deliberately ambiguous — absent,
   * another tenant, or archived concurrently — and the caller reports none of
   * those distinctions.
   */
  updateIfActive(input: {
    readonly contactId: ContactId;
    readonly patch: ContactUpdate;
    readonly now: number;
  }): Promise<boolean>;

  /** Conditional on being active. Returns whether it applied. */
  archiveIfActive(input: {
    readonly contactId: ContactId;
    readonly now: number;
  }): Promise<boolean>;

  /** Conditional on being archived. The inverse, and equally conditional. */
  restoreIfArchived(input: {
    readonly contactId: ContactId;
    readonly now: number;
  }): Promise<boolean>;
}

export interface ContactIdGenerator {
  nextContactId(): ContactId;
}
