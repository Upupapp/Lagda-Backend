// Signing recipient use cases (BACKEND-31).
//
// ── What a recipient is ────────────────────────────────────────────────────
//
// A participant in ONE preparation, holding a SNAPSHOT of a name, an email and
// an organization. Created by hand or copied from a contact, and after creation
// entirely its own record.
//
// ── The three boundaries this module exists to hold ────────────────────────
//
//   A recipient is not a contact.  `sourceContactId` is provenance. Nothing in
//   this file reads a contact except `addRecipient`, at the moment it copies —
//   an architecture guard asserts that, so a later "just refresh the name from
//   the contact" cannot be written without failing a test.
//
//   A recipient is not a user.     There is no lookup from a recipient email to
//   an account, and the type system makes one impossible: `RecipientEmailKey`
//   and `NormalizedEmail` are mutually unassignable brands, so
//   `findUserByNormalizedEmail(recipient.emailKey)` does not compile (§94).
//
//   A recipient is not authenticated. An email says where an invitation is
//   INTENDED to go. Nothing here proves anyone controls that mailbox, and there
//   is no field in which to record such a claim (§162).
//
// ── Authorization ──────────────────────────────────────────────────────────
//
// Reads need `document.view`, mutations need `document.prepare` — the same two
// capabilities as the layout, and deliberately no third.
//
// A separate `recipient.manage` would create a role that may place a signature
// field but not say who signs it, which is not a state the product has a screen
// for. Naming participants and placing their fields are one act in the editor,
// so they are one capability here (OD-128).

import type { ContactId, DocumentId, WorkspaceId, RecipientType } from "@lagda/contracts";
import {
  validateRecipientName, validateRecipientOrganization, validateRecipientEmail,
  canHoldFields, normalizeOrder, isValidRoutingOrder,
  isPreparationEditable, MAX_RECIPIENTS_PER_PREPARATION,
  type RecipientEmailKey, type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  PreparationId, PreparationIdGenerator, PreparationRecord,
  RecipientId, RecipientIdGenerator, RecipientRecord, RecipientUpdate,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";
import { ensurePreparationForDocument } from "../preparation/preparation.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Two recipients on one preparation would share a delivery address.
 *
 * ── Refused, unlike the contact duplicate, which only warns ────────────────
 *
 * A duplicate contact is a tidiness problem: two entries for one person in an
 * address book, and a person may legitimately appear twice. A duplicate
 * recipient is a correctness problem — the same mailbox would receive two
 * invitations to the same document, with two signing positions, and whoever
 * reads it cannot tell which one they are. §98 asks for a decision; this is it,
 * and RECIPIENT_DUPLICATE_POLICY.md records the reasoning.
 *
 * The address is NOT in the message. It is the one place an error would echo a
 * participant's contact details back to whoever typed them (§222).
 */
export class DuplicateRecipientError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "duplicate_recipient_email";
  constructor() {
    super("This document already has a recipient with that email address.");
  }
}

/**
 * The recipient still has fields assigned to it.
 *
 * Refused rather than cascaded. Deleting the fields with the recipient would
 * silently destroy placed work — a sender who removes the wrong party loses the
 * signature blocks they spent an afternoon positioning, with no undo (§118).
 *
 * The foreign key is RESTRICT, so this check is a better message rather than
 * the enforcement. A field inserted between the count and the delete makes the
 * DELETE fail; the database is what makes the rule race-safe.
 */
export class RecipientHasFieldsError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "recipient_has_assigned_fields";
  constructor(public readonly assignedFields: number) {
    super("Remove this recipient's fields before removing them from the document.");
  }
}

/** The preparation is frozen, so its participants can no longer change. */
export class PreparationNotEditableError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "preparation_not_editable";
  constructor() {
    super("This document can no longer be edited.");
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * A recipient as a client receives it.
 *
 * `emailKey` is absent — an internal comparison value, and a client that had it
 * would eventually compare it to a user's address and conclude something about
 * identity. `workspaceId` and `preparationId` are absent: both are in the URL.
 */
export interface RecipientView {
  readonly recipientId: string;
  readonly name: string;
  /** The delivery address, exactly as entered. Unverified. */
  readonly email: string;
  readonly organization: string | null;
  readonly type: RecipientType;
  readonly isRequired: boolean;
  readonly orderIndex: number;
  readonly routingOrder: number;
  /** Provenance only. Null once the source contact is deleted. */
  readonly sourceContactId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const toView = (record: RecipientRecord): RecipientView => ({
  recipientId: record.recipientId,
  name: record.name,
  email: record.email,
  organization: record.organization,
  type: record.type,
  isRequired: record.isRequired,
  orderIndex: record.orderIndex,
  routingOrder: record.routingOrder,
  sourceContactId: record.sourceContactId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export interface RecipientDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  /**
   * Both generators.
   *
   * A recipient cannot exist without a preparation to hold it, and the first
   * recipient added to a never-prepared document creates one — the same lazy
   * creation `saveDocumentPreparation` performs, through the same helper.
   */
  readonly ids: RecipientIdGenerator & PreparationIdGenerator;
}

// ── Shared resolution ────────────────────────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member, or no longer one. The same hidden 404 as everywhere else.
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

/** A mutation's preparation: created if needed, and refused if frozen. */
async function editablePreparation(
  uow: WorkspaceUnitOfWork,
  documentId: DocumentId,
  deps: RecipientDependencies,
  now: number,
): Promise<PreparationRecord> {
  const preparation = await ensurePreparationForDocument(uow, documentId, deps, now);
  if (!isPreparationEditable(preparation.lockedAt)) throw new PreparationNotEditableError();
  return preparation;
}

/**
 * One recipient of this document's preparation.
 *
 * Resolved through the preparation rather than by id alone. A recipient id from
 * another document is `null` here, and reported as absent — the same answer as
 * an id that never existed, so the endpoint cannot be used to discover which
 * ids are real (§122).
 */
async function resolveRecipient(
  uow: WorkspaceUnitOfWork,
  preparationId: PreparationId,
  recipientId: string,
): Promise<RecipientRecord> {
  const found = await uow.recipients.find({
    preparationId,
    recipientId: recipientId as RecipientId,
  });
  if (found === null) throw new ResourceNotFoundError("Recipient");
  return found;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * The document's recipients, in display order.
 *
 * An unprepared document has none, and asking does not create a preparation —
 * the same rule `getDocumentPreparation` follows, for the same reason: reading
 * must not write (§171).
 */
export async function listRecipients(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  deps: RecipientDependencies,
): Promise<readonly RecipientView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.view");

    // The document is resolved first so an unknown one is a 404 rather than an
    // empty list. "No recipients" and "no such document" are different answers,
    // and only the tenant boundary needs to blur them.
    const document = await uow.documents.findById(documentId);
    if (document === null) throw new ResourceNotFoundError("Document");

    const preparation = await uow.preparations.findByDocument(documentId);
    // Never prepared. An empty list, and NOT a created preparation: a read that
    // wrote would leave a row behind every document someone merely opened.
    if (preparation === null) return [];

    return (await uow.recipients.list(preparation.preparationId)).map(toView);
  });
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * A recipient's details, either typed or copied from the address book.
 *
 * A discriminated union rather than "contactId plus optional overrides",
 * because the two paths differ in where the trusted values come from. With
 * overrides, a caller could pass a contact id and a name that contradicts it,
 * and the server would have to decide which it believed.
 */
export type RecipientSource =
  | {
      readonly source: "manual";
      readonly name: string;
      readonly email: string;
      readonly organization?: string | null;
    }
  | {
      readonly source: "contact";
      /**
       * The contact to COPY FROM. Read once, at this instant.
       *
       * Not stored as a reference for later reading — see the module header.
       * The name and email are read inside the same transaction as the insert,
       * so the snapshot cannot be taken from a contact a concurrent edit has
       * already changed.
       */
      readonly contactId: string;
    };

export type AddRecipientInput = RecipientSource & {
  readonly type: RecipientType;
  /** Defaults to true: a participant nobody waits for is the unusual case. */
  readonly isRequired?: boolean;
  /** Defaults to 1 — everyone in parallel, which is the product's default flow. */
  readonly routingOrder?: number;
};

/**
 * Adds a recipient to a document's preparation.
 *
 * ── The snapshot happens here and only here ────────────────────────────────
 *
 * This is the single place in LAGDA that reads a contact to produce a
 * recipient. Everything afterwards works from the copy. `RECIPIENT_SNAPSHOT
 * _MODEL.md` states the consequences: editing the contact tomorrow changes
 * nothing here, deleting it nulls the provenance and nothing else.
 *
 * ── Appended, not inserted ─────────────────────────────────────────────────
 *
 * `orderIndex` is the current count, so a new recipient lands at the end.
 * Placing one in the middle is a reorder, which is its own operation and
 * renumbers the whole list at once.
 */
export async function addRecipient(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  input: AddRecipientInput,
  deps: RecipientDependencies,
): Promise<RecipientView> {
  const routingOrder = input.routingOrder ?? 1;
  if (!isValidRoutingOrder(routingOrder)) {
    throw new ApplicationValidationError(
      "That recipient could not be added.", ["routingOrder: must be 1 or greater"]);
  }

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");
    const now = deps.clock.now();
    const preparation = await editablePreparation(uow, documentId, deps, now);

    const existing = await uow.recipients.list(preparation.preparationId);
    if (existing.length >= MAX_RECIPIENTS_PER_PREPARATION) {
      throw new ApplicationValidationError(
        "This document has too many recipients.",
        [`recipients: at most ${String(MAX_RECIPIENTS_PER_PREPARATION)}`]);
    }

    const details = await resolveDetails(uow, input);

    // Checked here for the message, enforced by the unique index for the race.
    // Two simultaneous adds of one address both pass this and one fails on
    // commit; the catch below turns that into the same error.
    if (existing.some(recipient => recipient.emailKey === details.emailKey)) {
      throw new DuplicateRecipientError();
    }

    const recipientId = deps.ids.nextRecipientId();
    try {
      await uow.recipients.insert({
        recipientId,
        workspaceId: uow.workspaceId,
        preparationId: preparation.preparationId,
        sourceContactId: details.sourceContactId,
        name: details.name,
        email: details.email,
        emailKey: details.emailKey,
        organization: details.organization,
        type: input.type,
        isRequired: input.isRequired ?? true,
        orderIndex: existing.length,
        routingOrder,
        createdAt: now,
      });
    } catch {
      // The only unique constraint reachable from this insert is the
      // preparation-local email one — `recipientId` comes from the server's
      // generator, so a collision there is not a case to report differently.
      throw new DuplicateRecipientError();
    }

    return toView(await resolveRecipient(uow, preparation.preparationId, recipientId));
  });
}

/** The snapshot values, from whichever source the caller chose. */
interface RecipientDetails {
  readonly name: string;
  readonly email: string;
  readonly emailKey: RecipientEmailKey;
  readonly organization: string | null;
  readonly sourceContactId: ContactId | null;
}

async function resolveDetails(
  uow: WorkspaceUnitOfWork,
  input: AddRecipientInput,
): Promise<RecipientDetails> {
  if (input.source === "contact") {
    const contact = await uow.contacts.findById(input.contactId as ContactId);
    // Another tenant's contact is indistinguishable from an absent one.
    if (contact === null) throw new ResourceNotFoundError("Contact");

    // Re-validated, not trusted. The contact was validated by its own rules on
    // its own day, and a stored value that no longer satisfies today's rules
    // must not enter a new record unchecked (§59). It is also why this returns
    // the RECIPIENT's fold rather than reusing `contact.emailKey`: that value
    // is a `ContactEmailKey`, and the brands do not interchange.
    return validated({
      name: contact.name,
      email: contact.email,
      organization: contact.organization,
    }, contact.contactId);
  }
  return validated(input, null);
}

function validated(
  raw: {
    readonly name: string;
    readonly email: string;
    readonly organization?: string | null;
  },
  sourceContactId: ContactId | null,
): RecipientDetails {
  const issues: string[] = [];
  const name = validateRecipientName(raw.name);
  if (!name.ok) issues.push(`name: ${name.reason}`);
  const email = validateRecipientEmail(raw.email);
  if (!email.ok) issues.push(`email: ${email.reason}`);
  const organization = validateRecipientOrganization(raw.organization);
  if (!organization.ok) issues.push(`organization: ${organization.reason}`);

  if (!name.ok || !email.ok || !organization.ok) {
    throw new ApplicationValidationError("That recipient could not be saved.", issues);
  }
  return {
    name: name.value,
    // The DISPLAY address is stored. The fold is stored beside it, for
    // comparison only — an invitation goes to what was typed (§23).
    email: email.display,
    emailKey: email.key,
    organization: organization.value,
    sourceContactId,
  };
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * What a caller may change.
 *
 * Every key named. Not `Partial<RecipientView>`: `sourceContactId` would let a
 * caller rewrite provenance, and `orderIndex` would let one recipient be
 * renumbered out of step with the rest, which is what `reorderRecipients` is
 * for.
 */
export interface UpdateRecipientInput {
  readonly name?: string;
  readonly email?: string;
  readonly organization?: string | null;
  readonly type?: RecipientType;
  readonly isRequired?: boolean;
  readonly routingOrder?: number;
}

/**
 * Edits a recipient in place.
 *
 * ── Editing a recipient never touches its source contact ───────────────────
 *
 * Correcting a misspelt name here corrects it for this document only. The
 * address book is not updated, and cannot be: this module holds no write path
 * to `uow.contacts`, and an architecture guard asserts it (§113).
 *
 * ── Changing the type can invalidate placed fields ─────────────────────────
 *
 * Demoting a signer with fields to a `viewer` would leave fields assigned to a
 * participant who may not hold them. Refused, with the count, rather than
 * silently unassigning work someone placed.
 */
export async function updateRecipient(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  recipientId: string,
  input: UpdateRecipientInput,
  deps: RecipientDependencies,
): Promise<RecipientView> {
  if (input.routingOrder !== undefined && !isValidRoutingOrder(input.routingOrder)) {
    throw new ApplicationValidationError(
      "That recipient could not be saved.", ["routingOrder: must be 1 or greater"]);
  }

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");
    const now = deps.clock.now();
    const preparation = await editablePreparation(uow, documentId, deps, now);
    const current = await resolveRecipient(uow, preparation.preparationId, recipientId);

    // A MUTABLE `RecipientUpdate`, not `Record<string, unknown>`. The record
    // type would accept any key and any value, which is precisely the
    // mass-assignment shape the port's explicit field list exists to prevent —
    // and it would only be caught, if at all, at the repository boundary.
    const patch: { -readonly [K in keyof RecipientUpdate]: RecipientUpdate[K] } = {};

    if (input.name !== undefined) {
      const name = validateRecipientName(input.name);
      if (!name.ok) {
        throw new ApplicationValidationError(
          "That recipient could not be saved.", [`name: ${name.reason}`]);
      }
      patch.name = name.value;
    }

    if (input.email !== undefined) {
      const email = validateRecipientEmail(input.email);
      if (!email.ok) {
        throw new ApplicationValidationError(
          "That recipient could not be saved.", [`email: ${email.reason}`]);
      }
      // The duplicate rule applies to an edit exactly as to an add. Without
      // this, the rule would be trivially bypassed by adding then renaming.
      const others = await uow.recipients.list(preparation.preparationId);
      const clash = others.some(other =>
        other.recipientId !== current.recipientId && other.emailKey === email.key);
      if (clash) throw new DuplicateRecipientError();

      patch.email = email.display;
      patch.emailKey = email.key;
    }

    if (input.organization !== undefined) {
      const organization = validateRecipientOrganization(input.organization);
      if (!organization.ok) {
        throw new ApplicationValidationError(
          "That recipient could not be saved.", [`organization: ${organization.reason}`]);
      }
      // Explicit null clears it; the port distinguishes that from an absent key.
      patch.organization = organization.value;
    }

    if (input.type !== undefined && input.type !== current.type) {
      if (!canHoldFields(input.type)) {
        const assigned = await uow.recipients.countAssignedFields({
          preparationId: preparation.preparationId,
          recipientId: current.recipientId,
        });
        if (assigned > 0) throw new RecipientHasFieldsError(assigned);
      }
      patch.type = input.type;
    }

    if (input.isRequired !== undefined) patch.isRequired = input.isRequired;
    if (input.routingOrder !== undefined) patch.routingOrder = input.routingOrder;

    let applied = true;
    if (Object.keys(patch).length > 0) {
      try {
        applied = await uow.recipients.update({
          preparationId: preparation.preparationId,
          recipientId: current.recipientId,
          patch,
          now,
        });
      } catch {
        // The unique index, firing on a concurrent rename onto this address.
        throw new DuplicateRecipientError();
      }
    }
    if (!applied) throw new ResourceNotFoundError("Recipient");

    return toView(await resolveRecipient(uow, preparation.preparationId, recipientId));
  });
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * Removes a recipient from the document.
 *
 * A hard delete, and correctly so: a preparation recipient is authoring state
 * that has been sent nowhere and signed nothing. There is no history to
 * preserve, which is exactly what will change once BACKEND-32 sends a request —
 * at that point removal becomes a ceremony event, not a row deletion (§119).
 */
export async function removeRecipient(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  recipientId: string,
  deps: RecipientDependencies,
): Promise<void> {
  await deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");
    const now = deps.clock.now();
    const preparation = await editablePreparation(uow, documentId, deps, now);
    const current = await resolveRecipient(uow, preparation.preparationId, recipientId);

    const assigned = await uow.recipients.countAssignedFields({
      preparationId: preparation.preparationId,
      recipientId: current.recipientId,
    });
    if (assigned > 0) throw new RecipientHasFieldsError(assigned);

    try {
      const removed = await uow.recipients.remove({
        preparationId: preparation.preparationId,
        recipientId: current.recipientId,
      });
      if (!removed) throw new ResourceNotFoundError("Recipient");
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      // A field assigned between the count and the delete. The RESTRICT is
      // what makes the check above race-safe rather than advisory; the count
      // is unavailable here, so the error reports what is known.
      throw new RecipientHasFieldsError(assigned);
    }

    // Renumber, so removing the second of four leaves 0,1,2 rather than 0,2,3.
    // A sparse order would still sort correctly; it would also drift further
    // apart with every deletion until the numbers stopped meaning anything.
    const remaining = await uow.recipients.list(preparation.preparationId);
    await renumber(uow, preparation.preparationId, remaining, now);
  });
}

// ── Reorder ──────────────────────────────────────────────────────────────────

/**
 * Sets the display order from a complete list of recipient ids.
 *
 * ── Complete, not partial ──────────────────────────────────────────────────
 *
 * The caller sends every id, exactly once. A partial list would leave the
 * server guessing where the omitted ones go, and two clients would guess
 * differently. A missing or extra id is a validation failure, not a merge.
 *
 * ── Display order is not routing order ─────────────────────────────────────
 *
 * This changes `orderIndex` only. `routingOrder` — who waits for whom — is set
 * per recipient, because reordering a list for readability must not silently
 * rewrite the signing sequence (§78).
 */
export async function reorderRecipients(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  recipientIds: readonly string[],
  deps: RecipientDependencies,
): Promise<readonly RecipientView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");
    const now = deps.clock.now();
    const preparation = await editablePreparation(uow, documentId, deps, now);

    const current = await uow.recipients.list(preparation.preparationId);
    const byId = new Map(current.map(recipient => [String(recipient.recipientId), recipient]));

    const issues: string[] = [];
    const seen = new Set<string>();
    for (const [index, id] of recipientIds.entries()) {
      if (seen.has(id)) issues.push(`recipientIds[${String(index)}]: duplicated`);
      seen.add(id);
      if (!byId.has(id)) issues.push(`recipientIds[${String(index)}]: unknown`);
    }
    if (seen.size !== current.length) {
      issues.push(`recipientIds: must list all ${String(current.length)} recipients`);
    }
    if (issues.length > 0) {
      throw new ApplicationValidationError("That order could not be saved.", issues);
    }

    const ordered = recipientIds.map(id => byId.get(id)).filter(
      (recipient): recipient is RecipientRecord => recipient !== undefined);
    await renumber(uow, preparation.preparationId, ordered, now);

    return (await uow.recipients.list(preparation.preparationId)).map(toView);
  });
}

/**
 * Writes a dense 0-based `orderIndex` over the list, in the order given.
 *
 * Only the rows whose index actually changes are written. A reorder that moves
 * one recipient touches two rows, not fifty, and `updatedAt` stays honest for
 * the rest.
 */
async function renumber(
  uow: WorkspaceUnitOfWork,
  preparationId: PreparationId,
  ordered: readonly RecipientRecord[],
  now: number,
): Promise<void> {
  for (const { item, orderIndex } of normalizeOrder(ordered)) {
    if (item.orderIndex === orderIndex) continue;
    await uow.recipients.update({
      preparationId,
      recipientId: item.recipientId,
      patch: { orderIndex },
      now,
    });
  }
}

/**
 * Deliberately absent from this module.
 *
 * **resolveRecipientToUser / linkRecipientAccount** — §94. A recipient address
 * is never matched against `users`, and the brands make it a compile error.
 *
 * **sendInvitation / resendInvitation** — there is no email provider in this
 * command, and a recipient row is not a delivery record.
 *
 * **verifyRecipientEmail / issueAccessToken** — recipient authentication is
 * BACKEND-34. A `verifiedAt` written by anything here would be a claim LAGDA
 * cannot support.
 *
 * **syncFromContact / refreshRecipientDetails** — the snapshot rule, stated as
 * an absence. See RECIPIENT_SNAPSHOT_MODEL.md.
 */
export type RecipientOperationsDeferred = never;
