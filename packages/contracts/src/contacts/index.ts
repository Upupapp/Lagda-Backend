// The contact contract.
//
// ── A contact is not a person LAGDA knows ───────────────────────────────────
//
// It is address-book data one workspace typed in. LAGDA has verified nothing
// about it: the email address was never confirmed, the name was never checked
// against an identity document, and nobody on the other end agreed to anything.
//
// That is the single most important thing this contract says, and it is why
// there is no `userId` field, no `verified` flag and no `accountStatus` here.
// A field like that would invite a caller to treat address-book data as an
// authenticated identity, which is the failure this whole domain guards against.
// See CONTACT_IDENTITY.md.
//
// ── What is deliberately absent ─────────────────────────────────────────────
//
// The frontend's `Contact` model has `scope`, `ownerId`, `tagIds`, `groupIds`,
// `note`, `source`, `lastUsedAt` and `usageCount`. None appear here, each for a
// stated reason recorded in CONTACT_PRODUCT_INVENTORY.md. The two worth naming
// at the point of use:
//
//   - `note` is annotated in the product's own model as "internal note, never
//     stored in real persistence". Adding a column for it would contradict the
//     product's explicit instruction about its own field.
//   - `scope: personal | workspace` plus `ownerId` is a SECOND ownership axis
//     layered over tenancy, and the capability model has no concept of "yours
//     within the workspace". Shipping it half-understood would mean an
//     authorization rule invented here rather than read from the product.
//     REQUIRES_REVIEW — OD-107.

import { Type, type Static } from "@sinclair/typebox";
import { ContactIdSchema } from "../ids/index.js";

// ── Field limits ─────────────────────────────────────────────────────────────
//
// Stated in Unicode CODE POINTS, matching the column widths, for the same reason
// workspace names are: a byte limit rejects a short name written in Baybayin or
// Hanunuo while accepting a long one written in ASCII, which is a limit
// expressed in the wrong unit for a Philippine product.

export const CONTACT_NAME_MAX_LENGTH = 200;
export const CONTACT_NAME_MIN_LENGTH = 1;

/**
 * 254 — the RFC 5321 maximum for a whole address. The same limit
 * `users.normalized_email` uses, and identical here by coincidence of the
 * standard rather than because the two mean the same thing.
 */
export const CONTACT_EMAIL_MAX_LENGTH = 254;

/**
 * Phone is a FREE-TEXT string with a generous limit, not an E.164 field.
 *
 * The product's form takes plain text, and Philippine business contacts are
 * written every way there is: `0917 123 4567`, `+63 917 123 4567`,
 * `(02) 8123 4567 loc. 210`. Normalising to E.164 would need a default region,
 * would mangle the extension, and would reject a landline written the way its
 * owner writes it. Nothing in LAGDA dials a contact, so the strictness would buy
 * nothing and lose data.
 */
export const CONTACT_PHONE_MAX_LENGTH = 50;

export const CONTACT_ORGANIZATION_MAX_LENGTH = 200;
export const CONTACT_TITLE_MAX_LENGTH = 200;

// ── State ────────────────────────────────────────────────────────────────────

/**
 * A contact is `active` or `archived`. Nothing else.
 *
 * The product's `ContactStatus` also has `invalid` and `restricted`. Neither is
 * here: no operation in the product sets either one, they exist only in mock
 * fixture data, and a status the system can never enter is a state machine with
 * an unreachable node. If bounce handling (`invalid`) or compliance blocking
 * (`restricted`) arrive, they arrive with the operations that set them — OD-109.
 *
 * DERIVED from `archived_at`, never stored as a column, for the same reason
 * invitation state is derived: two representations of one fact drift, and the
 * one that drifts is always the denormalised one.
 */
export const CONTACT_STATES = ["active", "archived"] as const;
export type ContactState = (typeof CONTACT_STATES)[number];

export const ContactStateSchema = Type.Union(
  CONTACT_STATES.map(state => Type.Literal(state)),
  {
    title: "ContactState",
    description: "Whether the contact is in the active address book.",
  },
);

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * The sortable columns. A CLOSED list, and each has a supporting index.
 *
 * A whitelist rather than an arbitrary column name for the obvious injection
 * reason, and for a quieter one: an un-indexed sort column turns a cheap listing
 * into a full-table sort that only shows up under real data volume.
 *
 * The product's `ContactSortField` also offers `lastUsedAt` and `usageCount`.
 * Both are omitted because nothing in this backend writes them — recipient
 * creation does not exist yet — so sorting by either would order every contact
 * identically and look broken. They return with BACKEND-30 (OD-108).
 */
export const CONTACT_SORT_FIELDS = ["name", "organization", "updatedAt"] as const;
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];

export const ContactSortFieldSchema = Type.Union(
  CONTACT_SORT_FIELDS.map(field => Type.Literal(field)),
  { title: "ContactSortField" },
);

/** The product's `DEFAULT_CONTACT_QUERY` sorts by `updatedAt desc`. Matched. */
export const DEFAULT_CONTACT_SORT: ContactSortField = "updatedAt";

/**
 * Free-text search is bounded.
 *
 * An unbounded search term is an unbounded `ILIKE` pattern, which is a cheap way
 * for a caller to make the database do expensive work.
 */
export const CONTACT_SEARCH_MAX_LENGTH = 200;

// ── The wire shape ───────────────────────────────────────────────────────────

/**
 * A contact as a client receives it.
 *
 * Optional fields are `Type.Optional(Type.Union([..., Type.Null()]))` so an
 * absent phone number can be represented either by omission or by an explicit
 * `null`. The backend always emits `null`; accepting both keeps a client that
 * round-trips a record from having to strip keys.
 */
export const ContactSchema = Type.Object(
  {
    contactId: ContactIdSchema,
    name: Type.String({ minLength: CONTACT_NAME_MIN_LENGTH }),
    email: Type.String({ maxLength: CONTACT_EMAIL_MAX_LENGTH }),
    phone: Type.Union([Type.String(), Type.Null()]),
    organization: Type.Union([Type.String(), Type.Null()]),
    title: Type.Union([Type.String(), Type.Null()]),
    state: ContactStateSchema,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    archivedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  },
  {
    title: "Contact",
    additionalProperties: false,
    description:
      "An address-book entry owned by a workspace. NOT a LAGDA user account, "
      + "and nothing about it has been verified.",
  },
);
export type Contact = Static<typeof ContactSchema>;

// Note the absent field: `workspaceId`.
//
// It is in the URL — `/workspaces/:workspaceId/contacts/:contactId` — and
// echoing it into the body would invite a client to read the tenant off a
// record. Tenancy is a property of the request path and the transaction, not a
// field a caller inspects (INV-003).
