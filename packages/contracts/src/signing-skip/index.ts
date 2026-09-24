// The APPROVER skip surface (069) — an approver's counterpart to
// `signing-decline`'s decline. See that module's own header for the shared
// reasoning (no free-text, no Idempotency-Key needed); the one genuine
// difference is that a skip carries no reason at all.

import { Type, type Static } from "@sinclair/typebox";

/**
 * What a recipient sends to skip.
 *
 * EMPTY, and deliberately so — not merely "no field happens to be needed
 * yet". A skip is "I have nothing to add", and there is nothing for a
 * reason to explain. `additionalProperties: false` still applies: a client
 * that sends one gets a 422 rather than silent acceptance, the same
 * discipline `DeclineSigningBodySchema` applies to its own closed shape.
 */
export const SkipApprovalBodySchema = Type.Object(
  {},
  {
    additionalProperties: false,
    title: "SkipApprovalBody",
    description: "Empty. Skipping needs no input beyond the recipient's own session.",
  },
);

export type SkipApprovalBody = Static<typeof SkipApprovalBodySchema>;

/**
 * What the recipient gets back.
 *
 * The instant, and whether this call performed the skip — `DeclineSigning
 * ResponseSchema`'s exact shape. Nothing about the request's new state or
 * the other participants: the recipient is told what THEY did.
 */
export const SkipApprovalResponseSchema = Type.Object(
  {
    skippedAt: Type.Integer({ description: "Backend instant, epoch milliseconds." }),
    applied: Type.Boolean({
      description: "False when a concurrent skip had already been recorded.",
    }),
  },
  { additionalProperties: false, title: "SkipApprovalResponse" },
);

export type SkipApprovalResponse = Static<typeof SkipApprovalResponseSchema>;
