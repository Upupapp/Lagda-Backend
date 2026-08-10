// The signing recipient contract.
//
// ── A recipient is a SNAPSHOT ──────────────────────────────────────────────
//
// Name and email are copied when the recipient is created — from a contact or
// typed by hand — and never dereferenced again. A contact edited next week does
// not change a recipient created today, and a recipient edited today does not
// change the contact.
//
// That is the other half of the rule CONTACT_RECIPIENT_BOUNDARY.md stated in
// BACKEND-28, and it is why a document signed in March keeps saying who signed
// it after everyone's details change.
//
// ── Email is a DELIVERY address, not an identity ───────────────────────────
//
// It says where an invitation is intended to go. It does not prove who controls
// the mailbox, who opened the link, or who signed. There is deliberately no
// `emailVerified`, no `verifiedAt` and no `userId` in this file — BACKEND-34
// owns recipient authentication, and a field here would be a claim LAGDA cannot
// support.

import { Type, type Static } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The six participant roles, taken from the product.
 *
 * `prepare.ts` gives each its own written description — these are LAGDA's
 * vocabulary, not a copied one:
 *
 *   signer                    must complete required signature fields; blocks completion
 *   approver                  must approve or reject before later participants proceed
 *   reviewer                  reviews before later signing or approval steps
 *   acknowledgment-recipient  must acknowledge receipt where configured
 *   viewer                    may view; does not block completion
 *   carbon-copy               receives a copy of the completed document
 *
 * ── What the type does and does not mean here ──────────────────────────────
 *
 * BACKEND-31 stores the type and enforces exactly ONE rule from it: `viewer`
 * and `carbon-copy` may not be assigned fields, because `FIELD_ELIGIBLE_ROLES`
 * lists neither for any field type.
 *
 * What an approver's approval DOES — the action, the block, the transition — is
 * ceremony state and belongs to BACKEND-37. Storing the type now is not
 * implementing the behaviour.
 *
 * `witness` and in-person signing are absent: the product has neither, and §31
 * warns specifically against adding a witness role on legal-plausibility
 * grounds alone.
 *
 * ── Not WorkspaceRole ──────────────────────────────────────────────────────
 *
 * A completely separate vocabulary (§32). `reviewer` appears in both and means
 * different things: a workspace reviewer reads documents in the library; a
 * signing reviewer reviews one transaction. They must never share
 * authorization semantics.
 */
export const RECIPIENT_TYPES = [
  "signer",
  "approver",
  "reviewer",
  "acknowledgment-recipient",
  "viewer",
  "carbon-copy",
] as const;

export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const RecipientTypeSchema = Type.Union(
  RECIPIENT_TYPES.map(type => Type.Literal(type)),
  {
    title: "RecipientType",
    description: "What this participant is expected to do. Not a workspace role.",
  },
);

// ── Limits ───────────────────────────────────────────────────────────────────

export const RECIPIENT_NAME_MAX_LENGTH = 200;
export const RECIPIENT_NAME_MIN_LENGTH = 1;
/** RFC 5321's path limit, matching the column. */
export const RECIPIENT_EMAIL_MAX_LENGTH = 254;
export const RECIPIENT_ORGANIZATION_MAX_LENGTH = 200;

/**
 * A technical ceiling, not a plan entitlement (§152).
 *
 * 50 participants is far beyond any realistic agreement — a syndicated loan
 * with a dozen parties is unusual — and low enough that one request cannot
 * write unbounded rows. Operational safety, not pricing.
 */
export const MAX_RECIPIENTS_PER_PREPARATION = 50;

// ── The wire shape ───────────────────────────────────────────────────────────

/**
 * A recipient, as a client receives it.
 *
 * ── Read the absences ──────────────────────────────────────────────────────
 *
 * No `normalizedEmail` — an internal comparison value a client would eventually
 * compare to something. No `userId`, no `workspaceMemberId`, no
 * `isRegisteredUser`: resolving a recipient address to an account would leak
 * user existence and imply an authentication that has not happened (§128).
 *
 * No `accessToken`, no `otp`, no `authenticatedAt`, no `signedAt`, no
 * `viewedAt`, no `emailSentAt`. A preparation recipient is authoring state;
 * every one of those belongs to a ceremony that does not exist yet.
 */
export const RecipientSchema = Type.Object(
  {
    recipientId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: RECIPIENT_NAME_MIN_LENGTH }),
    /** The DELIVERY address, exactly as entered. Unverified. */
    email: Type.String({ maxLength: RECIPIENT_EMAIL_MAX_LENGTH }),
    organization: Type.Union([Type.String(), Type.Null()]),
    type: RecipientTypeSchema,
    /** Whether the workflow waits for this participant. Not a field's `required`. */
    isRequired: Type.Boolean(),
    /** Deterministic editor order. Separate from routing. */
    orderIndex: Type.Integer({ minimum: 0 }),
    /** The routing step. EQUAL VALUES MEAN PARALLEL within a step. */
    routingOrder: Type.Integer({ minimum: 1 }),
    /**
     * PROVENANCE only — that this recipient started from an address-book entry.
     *
     * Exposed because the editor needs it to show "from contacts" and to offer
     * re-picking. It is **never** an identity: nothing resolves a name or email
     * through it, and it becomes null if the contact is ever deleted.
     */
    sourceContactId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  {
    title: "Recipient",
    additionalProperties: false,
    description:
      "A signing participant, snapshotted onto one preparation. Not a contact, "
      + "not a user, and not an authenticated identity.",
  },
);
export type Recipient = Static<typeof RecipientSchema>;
