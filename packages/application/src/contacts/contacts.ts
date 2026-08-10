// Contact use cases (BACKEND-28).
//
// ── The invariant every function here maintains ────────────────────────────
//
//   Creating, editing or archiving a contact NEVER creates or modifies a user
//   account, a workspace membership, an invitation, or an authentication
//   credential.
//
// That is not a comment expressing an intention. Read the imports: this module
// cannot reach `users`, `memberships` or `invitations` through any dependency it
// declares, because the only repository it touches is `uow.contacts`. An
// architecture test asserts it, and the test would fail before a reviewer
// noticed.
//
// ── Authorization, and why it reads the actor inside the transaction ───────
//
// The same shape as member administration: the actor's role is read through the
// unit of work the write will use, so a contributor demoted mid-request cannot
// commit under authority they just lost. It costs one indexed query and closes
// a window on every mutation in the domain.

import type { ContactId, WorkspaceId, ContactSortField } from "@lagda/contracts";
import { DEFAULT_PER_PAGE } from "@lagda/contracts";
import {
  validateContactName, validateOptionalContactText, validateContactEmail,
  deriveContactState,
  CONTACT_PHONE_MAX_LENGTH, CONTACT_ORGANIZATION_MAX_LENGTH,
  CONTACT_TITLE_MAX_LENGTH, CONTACT_SEARCH_MAX_LENGTH,
  type ContactState, type ContactEmailKey, type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  ContactIdGenerator, ContactRecord, ContactUpdate,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";

// ── Projections ──────────────────────────────────────────────────────────────

/**
 * A contact as a client receives it.
 *
 * `emailKey` is ABSENT, and deliberately. It is an internal comparison value; a
 * client that received it would eventually compare it to a user's email and
 * conclude something about identity. The display address is the only one that
 * leaves the backend.
 *
 * `workspaceId` is absent too — it is in the URL, and echoing it into the body
 * invites a caller to read tenancy off a record.
 */
export interface ContactSummary {
  readonly contactId: ContactId;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly state: ContactState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

/**
 * A contact that shares an email address with the one being written.
 *
 * Returned ALONGSIDE a successful create or update, never instead of it — see
 * `CreateContactResult`. Carries just enough for a client to say "you already
 * have Maria Santos at Ayala Land"; not the full record, because a duplicate
 * warning is not a way to read contacts one at a time.
 */
export interface DuplicateWarning {
  readonly contactId: ContactId;
  readonly name: string;
  readonly organization: string | null;
}

function summarize(record: ContactRecord): ContactSummary {
  return {
    contactId: record.contactId,
    name: record.name,
    email: record.email,
    phone: record.phone,
    organization: record.organization,
    title: record.title,
    state: deriveContactState(record.archivedAt),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  };
}

const warn = (record: ContactRecord): DuplicateWarning => ({
  contactId: record.contactId,
  name: record.name,
  organization: record.organization,
});

export interface ContactDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: ContactIdGenerator;
}

// ── The transactional authorization frame ────────────────────────────────────

/**
 * Resolves the actor's CURRENT authority inside an open transaction.
 *
 * Identical in shape to `actorAuthorityInTransaction` in member administration,
 * and kept as a separate small function rather than shared: the two modules have
 * different dependency sets, and exporting a helper that takes a unit of work
 * would make it importable by code that has no business reading memberships.
 */
async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member, or no longer one. The same hidden 404 as everywhere else, so
  // "this workspace is not yours" and "you may not do that here" are one answer.
  if (membership === null) throw new ResourceNotFoundError("Workspace");

  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
  assertCapability(access, capability);
  return access;
}

// ── Input validation ─────────────────────────────────────────────────────────

export interface ContactInput {
  readonly name: string;
  readonly email: string;
  readonly phone?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
}

interface ValidatedContactFields {
  readonly name: string;
  readonly email: string;
  readonly emailKey: ContactEmailKey;
  readonly phone: string | null;
  readonly organization: string | null;
  readonly title: string | null;
}

/**
 * Validates every field and reports ALL the problems at once.
 *
 * Not fail-fast. A form with a bad email and an over-long organization name
 * should say both things on one round trip — reporting them one at a time makes
 * a user fix, submit, and be told about the next one, which is the interaction
 * `PolicyResult` exists to avoid elsewhere in this codebase.
 *
 * Issue strings name the FIELD and the PROBLEM and never echo the value. An
 * error message is a poor place for an email address: it reaches logs, error
 * reporting and, in a browser, sometimes a screenshot.
 */
function validateFields(input: ContactInput): ValidatedContactFields {
  const issues: string[] = [];

  const name = validateContactName(input.name);
  if (!name.ok) issues.push(`name: ${name.reason}`);

  const email = validateContactEmail(input.email);
  if (!email.ok) issues.push(`email: ${email.reason}`);

  const phone = validateOptionalContactText(input.phone, CONTACT_PHONE_MAX_LENGTH);
  if (!phone.ok) issues.push(`phone: ${phone.reason}`);

  const organization = validateOptionalContactText(
    input.organization, CONTACT_ORGANIZATION_MAX_LENGTH);
  if (!organization.ok) issues.push(`organization: ${organization.reason}`);

  const title = validateOptionalContactText(input.title, CONTACT_TITLE_MAX_LENGTH);
  if (!title.ok) issues.push(`title: ${title.reason}`);

  // One condition, doing two jobs: it throws when anything failed, and it is
  // what NARROWS each result to its `ok` branch for the return below.
  //
  // `issues.length > 0` alone would throw correctly and narrow nothing, leaving
  // `.value` unreachable without a cast — and a cast here would be a cast on
  // exactly the values a validator exists to guarantee. Naming every result
  // instead means a field added without a check is a compile error.
  if (!name.ok || !email.ok || !phone.ok || !organization.ok || !title.ok) {
    throw new ApplicationValidationError("The contact could not be saved.", issues);
  }

  return {
    name: name.value,
    email: email.display,
    emailKey: email.key,
    phone: phone.value,
    organization: organization.value,
    title: title.value,
  };
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateContactResult {
  readonly contact: ContactSummary;
  /**
   * Other ACTIVE contacts sharing this address. Empty in the ordinary case.
   *
   * The contact is created regardless. LAGDA warns about duplicates; it does not
   * prevent them — see CONTACT_DUPLICATE_POLICY.md. Two people at
   * `legal@example.com` is a real thing a law firm has, and refusing the second
   * would make the address book wrong to protect it from being untidy.
   */
  readonly duplicates: readonly DuplicateWarning[];
}

/**
 * Adds a contact to the workspace address book.
 *
 * ── What this function does not do, and cannot ─────────────────────────────
 *
 * It does not look up whether `input.email` belongs to a LAGDA user. It does not
 * create an account, send an invitation, or add a membership. It does not email
 * anyone — a contact is not notified that they were added, because they were not
 * asked and there is nothing to consent to.
 *
 * The email address is stored as typed and folded for comparison, and the folded
 * value carries a brand (`ContactEmailKey`) that the account lookup function
 * refuses to accept. The separation is enforced by the compiler, not by this
 * paragraph.
 */
export async function createContact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: ContactInput,
  deps: ContactDependencies,
): Promise<CreateContactResult> {
  // Validated BEFORE the transaction opens. A malformed submission should not
  // hold a database connection while it is being rejected.
  const fields = validateFields(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.create");

    const now = deps.clock.now();
    const contactId = deps.ids.nextContactId();

    // Read BEFORE the insert, so the new row is not reported as its own
    // duplicate. `excludeContactId` would also handle it; ordering makes the
    // intent legible and saves the exclusion doing invisible work.
    const duplicates = await uow.contacts.findDuplicateCandidates({
      emailKey: fields.emailKey,
      excludeContactId: null,
    });

    await uow.contacts.insert({
      contactId,
      workspaceId,
      name: fields.name,
      email: fields.email,
      emailKey: fields.emailKey,
      phone: fields.phone,
      organization: fields.organization,
      title: fields.title,
      createdAt: now,
    });

    const created = await uow.contacts.findById(contactId);
    // Written and immediately unreadable means RLS refused the read-back, which
    // would mean tenant context and the insert disagree. Not a user-facing
    // condition; it is a broken invariant, and the transaction should die.
    if (created === null) throw new ResourceNotFoundError("Contact");

    return { contact: summarize(created), duplicates: duplicates.map(warn) };
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getContact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  contactId: ContactId,
  deps: ContactDependencies,
): Promise<ContactSummary> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.view");
    const contact = await uow.contacts.findById(contactId);
    // A contact in another workspace produces the same null as one that does
    // not exist. The repository is scoped and RLS refuses it independently.
    if (contact === null) throw new ResourceNotFoundError("Contact");
    return summarize(contact);
  });
}

export interface ListContactsInput {
  readonly search?: string | null;
  readonly state?: ContactState;
  readonly sort?: ContactSortField;
  readonly direction?: "asc" | "desc";
  readonly page?: number;
  readonly perPage?: number;
}

export interface ContactListResult {
  readonly items: readonly ContactSummary[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly hasNextPage: boolean;
}

/**
 * Lists the address book.
 *
 * ── Defaults come from the product ─────────────────────────────────────────
 *
 * `updatedAt desc`, 20 per page, active only — matching `DEFAULT_CONTACT_QUERY`
 * in the frontend's own model. The default state filter matters most: a listing
 * that mixed archived contacts into the active book would offer them as
 * selectable recipients, which is what archiving them was meant to stop.
 *
 * ── Search is trimmed to null, not to empty ────────────────────────────────
 *
 * `?search=` and `?search=%20` mean "no search". Passing an empty pattern to the
 * repository would produce `ILIKE '%%'`, which matches everything including
 * rows where the column is NULL — a subtly different result set from no filter
 * at all, and the difference would only show up as missing contacts.
 */
export async function listContacts(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: ListContactsInput,
  deps: ContactDependencies,
): Promise<ContactListResult> {
  const rawSearch = (input.search ?? "").trim();
  if ([...rawSearch].length > CONTACT_SEARCH_MAX_LENGTH) {
    throw new ApplicationValidationError(
      "The search term is too long.", ["search: too-long"]);
  }
  const search = rawSearch.length === 0 ? null : rawSearch;

  const page = input.page ?? 1;
  const perPage = input.perPage ?? DEFAULT_PER_PAGE;

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.view");

    const result = await uow.contacts.list({
      search,
      state: input.state ?? "active",
      sort: input.sort ?? "updatedAt",
      direction: input.direction ?? "desc",
      offset: (page - 1) * perPage,
      limit: perPage,
    });

    return {
      items: result.items.map(summarize),
      total: result.total,
      page,
      perPage,
      hasNextPage: page * perPage < result.total,
    };
  });
}

// ── Update ───────────────────────────────────────────────────────────────────

export interface UpdateContactResult {
  readonly contact: ContactSummary;
  /** Other active contacts now sharing this address. Same policy as create. */
  readonly duplicates: readonly DuplicateWarning[];
}

/**
 * Edits a contact.
 *
 * ── Editing a contact never rewrites history ───────────────────────────────
 *
 * This is the rule worth being explicit about, and it holds because of something
 * that is NOT in this file. When a document is sent, its recipients are a
 * SNAPSHOT — name and email copied at send time into the signing record. They do
 * not reference `contacts.contact_id`, so no edit here can reach them.
 *
 * Renaming a contact from "Maria Santos" to "Maria Santos-Cruz" therefore
 * changes the address book and changes nothing about a document she already
 * signed. That is the correct behaviour for eSignature evidence, and it is
 * structural rather than something this function remembers to avoid.
 * CONTACT_RECIPIENT_BOUNDARY.md, and an architecture test.
 *
 * ── Archived contacts are read-only ────────────────────────────────────────
 *
 * `updateIfActive` refuses. Restore it first — maintaining a record nobody can
 * select is work with no result, and permitting it would mean an archived
 * contact could be quietly edited into a different person.
 */
export async function updateContact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  contactId: ContactId,
  input: ContactInput,
  deps: ContactDependencies,
): Promise<UpdateContactResult> {
  const fields = validateFields(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.update");

    const existing = await uow.contacts.findById(contactId);
    if (existing === null) throw new ResourceNotFoundError("Contact");

    const patch: ContactUpdate = {
      name: fields.name,
      email: fields.email,
      emailKey: fields.emailKey,
      phone: fields.phone,
      organization: fields.organization,
      title: fields.title,
    };

    const applied = await uow.contacts.updateIfActive({
      contactId, patch, now: deps.clock.now(),
    });
    // Absent, another tenant, or archived — including archived concurrently by
    // someone else. Deliberately one answer; the caller re-reads rather than
    // being told which.
    if (!applied) throw new ResourceNotFoundError("Contact");

    const duplicates = await uow.contacts.findDuplicateCandidates({
      emailKey: fields.emailKey,
      // "Anything OTHER than me" — the question an edit actually has. Without
      // this every save of an unchanged email would warn about itself.
      excludeContactId: contactId,
    });

    const updated = await uow.contacts.findById(contactId);
    if (updated === null) throw new ResourceNotFoundError("Contact");

    return { contact: summarize(updated), duplicates: duplicates.map(warn) };
  });
}

// ── Archive and restore ──────────────────────────────────────────────────────

/**
 * Removes a contact from the active address book.
 *
 * ── This is the product's delete, and there is no other ────────────────────
 *
 * `ContactActionId` in the frontend offers `archive` and `restore`; it has no
 * delete, and the mock service has `archiveContact`/`restoreContact` and no
 * `deleteContact`. The backend follows, and follows it all the way down: the
 * runtime database role has **no DELETE grant** on `contacts`, so erasure is not
 * available to application code even by mistake.
 *
 * ── Why archiving is the right model regardless ────────────────────────────
 *
 * A contact may be the source of a recipient on a signed document. The snapshot
 * means deletion would not corrupt that evidence — but it would destroy the
 * workspace's own record of who they had been dealing with, on a platform whose
 * product is proof. Reversible removal costs a nullable timestamp.
 *
 * Hard deletion, if it is ever required for a data-subject erasure request under
 * the Data Privacy Act, is a deliberate compliance operation with its own
 * authority, audit trail and interaction with signing evidence — not this
 * button. OD-110.
 */
export async function archiveContact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  contactId: ContactId,
  deps: ContactDependencies,
): Promise<ContactSummary> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.archive");

    const applied = await uow.contacts.archiveIfActive({
      contactId, now: deps.clock.now(),
    });
    // Absent, another tenant, or already archived. Archiving an archived contact
    // is not an error worth its own response — but it did not happen, and
    // reporting success would tell a client its state was current when it was
    // not. One ambiguous answer, and the client re-reads.
    if (!applied) throw new ResourceNotFoundError("Contact");

    const archived = await uow.contacts.findById(contactId);
    if (archived === null) throw new ResourceNotFoundError("Contact");
    return summarize(archived);
  });
}

/** The inverse. Same capability — one reversible control, not two authorities. */
export async function restoreContact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  contactId: ContactId,
  deps: ContactDependencies,
): Promise<ContactSummary> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "contact.archive");

    const applied = await uow.contacts.restoreIfArchived({
      contactId, now: deps.clock.now(),
    });
    if (!applied) throw new ResourceNotFoundError("Contact");

    const restored = await uow.contacts.findById(contactId);
    if (restored === null) throw new ResourceNotFoundError("Contact");
    return summarize(restored);
  });
}

/**
 * Deliberately absent from this module.
 *
 * **deleteContact** — the product has no delete action and the database role has
 * no DELETE grant. Erasure for a Data Privacy Act request is a separate
 * compliance operation (OD-110).
 *
 * **mergeContacts** — the product's duplicate view has a `merge-demonstration`
 * action, and the name is the product telling us it is not real. Merging is
 * destructive, has to decide which record's history survives, and would be the
 * one operation in this domain that could touch a record a document was sent
 * from. It needs a product answer that does not exist (OD-111).
 *
 * **importContacts / CSV** — no import UI exists. Bulk creation through this
 * module's single-contact path would be an unbounded write loop with no rate
 * limit designed for it (OD-112).
 *
 * **tags and groups** — modelled in the frontend, governed by no operation, and
 * the command that owns them is not this one.
 */
export type ContactOperationsDeferred = never;
