// Turning frozen inputs into a message, safely.
//
// ── The three ways this goes wrong ─────────────────────────────────────────
//
// A notification body is the one place in LAGDA where attacker-influenced text
// meets a markup language and a line-oriented wire protocol at the same time.
// Three separate failures live here, and each needs its own defence:
//
//   HTML injection      a recipient named `<script>` in the HTML part
//   header injection    a CRLF in a subject, splitting one header into two
//   unbounded content   a 4 MB "custom message" a provider will reject
//
// Escaping the HTML does not stop the header split, and rejecting the CRLF
// does not bound the size. All three are enforced here so no template author
// has to remember any of them.
//
// ── Why rendering lives in application and not core ────────────────────────
//
// `@lagda/core` answers "is this allowed?" about the domain. A subject line is
// not a domain rule. But rendering is still pure — no clock, no I/O, no
// randomness — so it is testable with fixtures and deterministic across
// deployments, which S205 requires.

/**
 * The five characters that change meaning inside HTML text or an attribute.
 *
 * Quotes are included because template output is interpolated into attribute
 * positions (`href`, `alt`), where escaping only `<` and `&` leaves an
 * attribute breakout available.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes text for interpolation into HTML.
 *
 * `&` is replaced first by virtue of being in the character class — order
 * matters only if the replacements were applied in sequence, which is why this
 * is a single pass rather than five chained `replace` calls. Five chained calls
 * is the classic double-escaping bug: `<` becomes `&lt;` and then the `&` pass
 * turns it into `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}

/**
 * Characters forbidden in a subject line.
 *
 * CR and LF are the injection vector — a subject containing `\r\nBcc: ...`
 * becomes a second header in a naive transport. The other C0 controls and the
 * Unicode bidirectional overrides are here because a subject is rendered in a
 * mail client's list view, where an override can make one sender's mail
 * display another's name.
 */
const FORBIDDEN_SUBJECT_CHARACTERS = /[\r\n\p{Cc}\p{Cf}]/u;

/** The bound on a rendered subject. Longer is truncated by every mail client. */
export const MAX_SUBJECT_LENGTH = 200;
/** The bound on a rendered body part. */
export const MAX_BODY_LENGTH = 100_000;

export class NotificationRenderError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "SUBJECT_CONTROL_CHARACTERS"
      | "SUBJECT_TOO_LONG"
      | "BODY_TOO_LONG",
  ) {
    super(message);
    this.name = "NotificationRenderError";
  }
}

/**
 * Validates a rendered subject.
 *
 * Rejects rather than strips (S72 permits either). Stripping would silently
 * deliver a subject the template author did not write, and the only way a
 * control character reaches here is a validation gap upstream — which should
 * surface as a failure, not be quietly repaired at the last moment.
 */
export function assertSafeSubject(subject: string): string {
  if (FORBIDDEN_SUBJECT_CHARACTERS.test(subject)) {
    throw new NotificationRenderError(
      "Subject contains control characters",
      "SUBJECT_CONTROL_CHARACTERS",
    );
  }
  if ([...subject].length > MAX_SUBJECT_LENGTH) {
    throw new NotificationRenderError("Subject exceeds maximum length", "SUBJECT_TOO_LONG");
  }
  return subject;
}

/** Bounds a rendered body part. */
export function assertBoundedBody(body: string): string {
  if (body.length > MAX_BODY_LENGTH) {
    throw new NotificationRenderError("Body exceeds maximum length", "BODY_TOO_LONG");
  }
  return body;
}
