// Signing recipient ports (BACKEND-31).
//
// ── Methods that are deliberately absent ───────────────────────────────────
//
//   findByEmail(...)         across preparations. A recipient is scoped to one
//                            preparation; a global lookup by address would be
//                            "which documents is this person signing", which is
//                            a different feature with different authorization.
//   findByContact(...)       same — and it would invite treating the contact as
//                            the identity.
//   linkToUser(...)          a recipient is never resolved to an account (§94).
//   markVerified / issueToken / recordSignature
//                            authentication and ceremony state. BACKEND-34/37.

import type { ContactId, WorkspaceId, RecipientType } from "@lagda/contracts";
import type { RecipientEmailKey } from "@lagda/core";
import type { PreparationId } from "./preparation.js";

/** Opaque, server-generated. Never derived from an email, contact or index (§7). */
export type RecipientId = string & { readonly __brand: "RecipientId" };

/**
 * A recipient, as persisted.
 *
 * `name`, `email` and `organization` are SNAPSHOT values. Nothing dereferences
 * `sourceContactId` to obtain them, and an architecture guard asserts the
 * recipient module never reads a contact except during creation.
 */
export interface RecipientRecord {
  readonly recipientId: RecipientId;
  readonly workspaceId: WorkspaceId;
  readonly preparationId: PreparationId;
  /** PROVENANCE only, and null once a source contact is deleted. */
  readonly sourceContactId: ContactId | null;
  readonly name: string;
  /** The delivery address, exactly as entered. Unverified. */
  readonly email: string;
  readonly emailKey: RecipientEmailKey;
  readonly organization: string | null;
  readonly type: RecipientType;
  readonly isRequired: boolean;
  readonly orderIndex: number;
  readonly routingOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewRecipient {
  readonly recipientId: RecipientId;
  readonly workspaceId: WorkspaceId;
  readonly preparationId: PreparationId;
  readonly sourceContactId: ContactId | null;
  readonly name: string;
  readonly email: string;
  readonly emailKey: RecipientEmailKey;
  readonly organization: string | null;
  readonly type: RecipientType;
  readonly isRequired: boolean;
  readonly orderIndex: number;
  readonly routingOrder: number;
  readonly createdAt: number;
}

/**
 * The fields an update may change. Every one explicitly named.
 *
 * NOT `Partial<RecipientRecord>`. That would let a caller pass
 * `{ sourceContactId }` and rewrite provenance (§135), `{ preparationId }` and
 * move a recipient between documents, or `{ createdAt }` and rewrite history —
 * the mass-assignment shape banned since INV-306.
 *
 * `organization` accepts `null` to clear it; an absent key leaves it alone.
 */
export interface RecipientUpdate {
  readonly name?: string;
  readonly email?: string;
  readonly emailKey?: RecipientEmailKey;
  readonly organization?: string | null;
  readonly type?: RecipientType;
  readonly isRequired?: boolean;
  readonly orderIndex?: number;
  readonly routingOrder?: number;
}

/**
 * Recipient persistence, bound to ONE workspace and ONE transaction.
 *
 * Every method also takes the PREPARATION, because tenant scope alone is not
 * enough here: two preparations in one workspace are both visible to RLS, and
 * only the parent check stops a recipient from one being used by the other
 * (§122).
 */
export interface ScopedRecipientRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(recipient: NewRecipient): Promise<void>;

  /** One recipient of this preparation, or null. */
  find(input: {
    readonly preparationId: PreparationId;
    readonly recipientId: RecipientId;
  }): Promise<RecipientRecord | null>;

  /** Ordered by `orderIndex`, then id. Ordered in SQL. */
  list(preparationId: PreparationId): Promise<readonly RecipientRecord[]>;

  /**
   * Applies an update. Returns whether it applied.
   *
   * Zero rows is deliberately ambiguous — absent, another tenant, or another
   * preparation — and the caller reports none of those distinctions.
   */
  update(input: {
    readonly preparationId: PreparationId;
    readonly recipientId: RecipientId;
    readonly patch: RecipientUpdate;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Removes a recipient.
   *
   * The database refuses this while any field still references it — the
   * assignment foreign key is RESTRICT. The use case checks first so the caller
   * gets a specific error rather than a constraint violation, and the
   * constraint is what makes the check race-safe.
   */
  remove(input: {
    readonly preparationId: PreparationId;
    readonly recipientId: RecipientId;
  }): Promise<boolean>;

  /** How many fields are assigned to this recipient. For the delete check. */
  countAssignedFields(input: {
    readonly preparationId: PreparationId;
    readonly recipientId: RecipientId;
  }): Promise<number>;
}

export interface RecipientIdGenerator {
  nextRecipientId(): RecipientId;
}
