// Domain primitives shared across LAGDA's business rules.
//
// Deliberately small. `common` is where cross-domain concepts live, not a
// utilities drawer — array helpers and string formatters do not belong in a
// domain package merely because they are reusable.

// ── Outcome strategy ─────────────────────────────────────────────────────────
//
// TWO MECHANISMS, chosen by whether the caller can do anything about the
// failure. Mixing them arbitrarily is what makes a domain layer hard to use.
//
//   PolicyResult  — a question with a possibly-negative answer, where the
//                   caller wants ALL the reasons. "Can this be sent?" returns
//                   four unmet conditions, and a form shows four messages.
//                   Never throws.
//
//   DomainError   — an operation attempted against an impossible state.
//                   "Complete a cancelled request" is not a form problem; it is
//                   a caller doing something the domain forbids. Thrown.
//
// The test: could a well-behaved user cause this? Then it is a policy result.

/** A machine-readable reason a policy did not pass. Never UI copy. */
export interface PolicyIssue<TCode extends string = string> {
  readonly code: TCode;
  /** Aids debugging. Callers must branch on `code`, never on this text. */
  readonly detail: string;
}

export type PolicyResult<TCode extends string = string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly PolicyIssue<TCode>[] };

export const policyOk = (): PolicyResult<never> => ({ ok: true });

export const policyFailed = <TCode extends string>(
  issues: readonly PolicyIssue<TCode>[],
): PolicyResult<TCode> => ({ ok: false, issues });

// ── Domain errors ────────────────────────────────────────────────────────────

/**
 * Base for violations of a domain rule.
 *
 * Carries a `code` and no HTTP status, no log level, and no severity — the
 * application layer decides how to present and record it. Mapping a domain
 * code to an API error code is BACKEND-05's job, and the two vocabularies stay
 * separate: an internal code is free to change without breaking a client.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A lifecycle transition the domain does not permit.
 *
 * Messages name states and actions, never people or documents — an error
 * message is a poor place for an email address, and it tends to end up in logs
 * and error reporting.
 */
export class InvalidStateTransitionError extends DomainError {
  readonly code = "invalid_state_transition";

  constructor(
    readonly entity: string,
    readonly from: string,
    readonly action: string,
  ) {
    super(`${entity} cannot ${action} from state "${from}".`);
  }
}

/** A rule that must hold regardless of how the state was reached. */
export class InvariantViolationError extends DomainError {
  readonly code = "invariant_violation";

  constructor(readonly invariant: string, detail: string) {
    super(`${invariant}: ${detail}`);
  }
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * An instant, as milliseconds since the epoch.
 *
 * A number rather than a `Date` because `Date` is mutable — handing one to a
 * caller lets them change an aggregate's timestamps by accident. Comparison and
 * equality are also exact, which matters for deterministic tests.
 *
 * **Core never reads the clock.** Every time-dependent rule takes `now` as an
 * argument, so a test can run the same expiry check in 2026 and 2036 and get
 * the same answer without stubbing globals.
 */
export type Instant = number & { readonly __brand: "Instant" };

export const instantFromIso = (iso: string): Instant => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new InvariantViolationError("Instant", `"${iso}" is not a valid timestamp.`);
  }
  return ms as Instant;
};

export const instantToIso = (instant: Instant): string =>
  new Date(instant).toISOString();

/** Deadlines are exclusive: an item is expired strictly after its deadline. */
export const hasPassed = (deadline: Instant, now: Instant): boolean => now > deadline;

// ── Email syntax ─────────────────────────────────────────────────────────────
//
// SYNTAX ONLY, and the distinction is the point of putting it here.
//
// Two unrelated domains need to know whether a string LOOKS like an email
// address: account identity (`normalizeEmail`, which turns one into an
// authentication key) and contacts (which stores one as address-book text and
// authenticates nothing). They must agree on the shape and must NOT share the
// identity semantics — a contact email is not an account lookup key, and a type
// that let one be used as the other is the conflation CONTACT_IDENTITY.md
// exists to prevent.
//
// So the shape lives here, unbranded and meaning nothing on its own, and each
// domain builds its own semantics on top. Before BACKEND-28 this pattern was
// private to `email-identity.ts`; the alternative was a second copy of the
// regex in the contact domain, which is two rules that agree until one is
// edited.

/**
 * Structure only, deliberately.
 *
 * A regex cannot decide whether a mailbox exists or accepts mail — only delivery
 * can. Attempting RFC 5322 in a pattern produces something unreadable that still
 * rejects valid addresses. This checks that there is a local part, one `@`, a
 * domain with a dot, and no whitespace.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The RFC 5321 path limit. Longer than this is not a mailbox anyone receives at. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Whether a string has the shape of an email address.
 *
 * Says nothing about whether it can receive mail, whether it belongs to a LAGDA
 * account, or whether anyone has verified it. Callers that need any of those
 * must establish them separately.
 */
export function hasEmailSyntax(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}

// ── Exhaustiveness ───────────────────────────────────────────────────────────

/**
 * Fails to compile when a union gains a member that a switch does not handle.
 *
 * This is how a new canonical status forces domain review instead of silently
 * falling through a `default` branch. Adding a serialized status is a business
 * decision, and the compiler is the cheapest place to insist someone makes it.
 */
export function assertNever(value: never, context: string): never {
  throw new InvariantViolationError(
    context,
    `Unhandled variant: ${JSON.stringify(value)}`,
  );
}
