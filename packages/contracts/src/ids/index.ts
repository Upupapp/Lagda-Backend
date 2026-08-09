// Canonical identifier contracts.
//
// Branded at compile time, plain strings at runtime — so `JSON.stringify({ id })`
// behaves exactly as it reads, while the compiler still refuses to let a
// DocumentId be passed where a WorkspaceId belongs.
//
// WHY BRANDING MATTERS MOST HERE. The frontend declares 91 branded ID types, but
// applies them least to the one that carries the security boundary: `workspaceId`
// is typed `WorkspaceId` in 6 declarations against 21 typed plain `string`, and
// `transactionId`, `documentId` and `userId` have no branded type at all. Tenant
// isolation is enforced at the data-access boundary (INV-003), and that rule is
// only compiler-checkable if the tenant key is a distinct type. Branding it here
// is what turns INV-003 from a review item into a type error.

import { Type, type Static } from "@sinclair/typebox";

/**
 * Compile-time brand. Erased at runtime, so the value is just a string on the
 * wire — no wrapper object, no custom serializer, no transport handling.
 */
declare const brand: unique symbol;
type Branded<T extends string> = string & { readonly [brand]: T };

// ── The tenant boundary ──────────────────────────────────────────────────────

/** The workspace that owns a record. Every tenant-owned query is scoped by this. */
export type WorkspaceId = Branded<"WorkspaceId">;

// ── Identity ─────────────────────────────────────────────────────────────────

export type UserId = Branded<"UserId">;
export type WorkspaceMemberId = Branded<"WorkspaceMemberId">;
export type WorkspaceTeamId = Branded<"WorkspaceTeamId">;

// ── Documents and signing ────────────────────────────────────────────────────

/**
 * A signing transaction. The frontend calls this `transactionId` throughout, and
 * that name is kept deliberately — renaming an established field to a tidier one
 * is churn with a compatibility cost and no product benefit.
 */
export type TransactionId = Branded<"TransactionId">;
export type DocumentId = Branded<"DocumentId">;
export type TemplateId = Branded<"TemplateId">;
export type ContactId = Branded<"ContactId">;

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * The public verification reference. Distinct from `TransactionId` on purpose:
 * a verification identifier is quoted publicly and appears on a completion
 * certificate, whereas a transaction identifier addresses an internal record.
 * Conflating them would make a public reference usable to address private data.
 */
export type VerificationId = Branded<"VerificationId">;

// ── Runtime schemas ──────────────────────────────────────────────────────────
// Non-empty strings. Format is NOT constrained here: the generation strategy is
// a backend concern (BACKEND-06), and encoding a prefix convention in a shared
// contract would freeze an implementation detail neither side has decided.

const IdSchema = (name: string) =>
  Type.String({ minLength: 1, title: name, description: `Opaque ${name}.` });

export const WorkspaceIdSchema = IdSchema("WorkspaceId");
export const UserIdSchema = IdSchema("UserId");
export const WorkspaceMemberIdSchema = IdSchema("WorkspaceMemberId");
export const WorkspaceTeamIdSchema = IdSchema("WorkspaceTeamId");
export const TransactionIdSchema = IdSchema("TransactionId");
export const DocumentIdSchema = IdSchema("DocumentId");
export const TemplateIdSchema = IdSchema("TemplateId");
export const ContactIdSchema = IdSchema("ContactId");
export const VerificationIdSchema = IdSchema("VerificationId");

/**
 * Runtime validation cannot recover a brand — every ID is the same string shape
 * on the wire. These assert the value is a well-formed identifier; which *kind*
 * it is comes from the position it occupies in a validated request or response.
 */
export type AnyIdString = Static<typeof WorkspaceIdSchema>;
