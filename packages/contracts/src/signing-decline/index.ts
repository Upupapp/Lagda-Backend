// The recipient decline surface (BACKEND-37, routed by OD-154).

import { Type, type Static } from "@sinclair/typebox";
import { SigningDeclineReasonSchema } from "../signing-requests/index.js";

/**
 * What a recipient sends to refuse.
 *
 * ONE field, and it is a closed enum.
 *
 * The product's `DeclinePage` also offers an optional free-text note, and this
 * schema deliberately has nowhere to put it. A body field that does not exist
 * cannot be logged, cannot be stored, and cannot arrive at all — which is a
 * stronger guarantee than accepting it and discarding it. The reasoning is in
 * `signing-state/SIGNING_TERMINAL_STATES.md`.
 *
 * `additionalProperties: false`, so a client that sends the note gets a 400
 * rather than silent acceptance.
 */
export const DeclineSigningBodySchema = Type.Object(
  { reason: SigningDeclineReasonSchema },
  {
    additionalProperties: false,
    title: "DeclineSigningBody",
    description: "Why the recipient is declining. A closed vocabulary.",
  },
);

export type DeclineSigningBody = Static<typeof DeclineSigningBodySchema>;

/**
 * What the recipient gets back.
 *
 * The instant, and whether this call performed the decline. Nothing about the
 * request's new state, the other participants, or what happens next: the
 * recipient is told what THEY did.
 */
export const DeclineSigningResponseSchema = Type.Object(
  {
    declinedAt: Type.Integer({ description: "Backend instant, epoch milliseconds." }),
    applied: Type.Boolean({
      description: "False when a concurrent decline had already been recorded.",
    }),
  },
  { additionalProperties: false, title: "DeclineSigningResponse" },
);

export type DeclineSigningResponse = Static<typeof DeclineSigningResponseSchema>;

// ── Sender cancellation ──────────────────────────────────────────────────────

/** The product requires a reason and trims it to 200. Both are matched. */
export const CANCEL_REASON_MAX_LENGTH = 200;

export const CancelSigningRequestBodySchema = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: CANCEL_REASON_MAX_LENGTH,
      description: "Why the sender is withdrawing the request. Required.",
    }),
  },
  { additionalProperties: false, title: "CancelSigningRequestBody" },
);

export type CancelSigningRequestBody = Static<typeof CancelSigningRequestBodySchema>;

/**
 * What the sender gets back.
 *
 * COUNTS, never who held them. "Three credentials were revoked" is what an
 * operator needs; "these three addresses were revoked" is a disclosure the
 * response has no reason to make.
 */
export const CancelSigningRequestResponseSchema = Type.Object(
  {
    signingRequestId: Type.String(),
    state: Type.Literal("cancelled"),
    cancelledAt: Type.Integer(),
    revokedGrantCount: Type.Integer(),
    revokedSessionCount: Type.Integer(),
  },
  { additionalProperties: false, title: "CancelSigningRequestResponse" },
);

export type CancelSigningRequestResponse =
  Static<typeof CancelSigningRequestResponseSchema>;
