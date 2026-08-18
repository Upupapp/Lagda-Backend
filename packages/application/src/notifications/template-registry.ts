// The template registry: server-owned copy, versioned, strictly typed.
//
// ── Code, not a database table ─────────────────────────────────────────────
//
// S203/S204 leave the choice open and code wins. A database template table is
// only worth its cost if somebody edits templates without a deploy, and LAGDA
// has no admin template editor. What it would add immediately is a way for a
// row to become the body of an email — which is the arbitrary-content problem
// S61 exists to prevent, arriving through the back door.
//
// ── Why versions are registered rather than replaced ───────────────────────
//
// An intent freezes `key` + `version` at creation (S59). If v2 replaced v1 in
// place, every intent queued before the deploy would render with v2's wording
// and v2's model — and any intent whose frozen input lacked a variable v2
// introduced would render a blank where a document title should be.
//
// So both live in the registry simultaneously, keyed by version, and v1 is
// removed only once no pending intent references it (S74). Lookup of an
// unregistered version FAILS rather than falling back to the newest (S243):
// silently rendering the latest is precisely the substitution the freeze
// exists to prevent.

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  NotificationTemplateKey, NotificationTemplateRef, NotificationLocale,
  NotificationTemplateInput, EmailMessage,
} from "../common/ports/notifications.js";
import { assertSafeSubject, assertBoundedBody } from "./rendering.js";

/**
 * What a template needs at render time beyond its frozen input.
 *
 * ── Why the secret is a parameter and not a field ──────────────────────────
 *
 * The raw credential never lives in the intent, the delivery, the queue payload
 * or the log (S78, S80, S126). It is resolved immediately before rendering and
 * discarded immediately after (S152, S153). Passing it as an argument is what
 * makes that lifetime visible: there is no object holding it, so there is
 * nothing to accidentally persist or serialise.
 *
 * `null` for a template that carries no secret. A secret-bearing template
 * receiving `null` throws rather than rendering a message with a missing link.
 */
export interface RenderContext {
  /** Raw one-time secret, live only for this call. Never stored, never logged. */
  readonly secret: string | null;
  /**
   * Builds first-party URLs from CONFIGURED base only.
   *
   * Never from an inbound `Host` or `X-Forwarded-Host` (S147): an attacker who
   * controls the host header of the request that triggered a notification would
   * otherwise choose the domain a reset link points at.
   */
  readonly buildLink: (path: string, token: string) => string;
}

/**
 * One registered template version.
 *
 * `schema` is the authority on the frozen input. It validates on the way in, so
 * an intent cannot be created with a model the template cannot render, and on
 * the way out, so a row written by an older deployment cannot render as
 * `undefined` (S244). `additionalProperties: false` throughout means an unknown
 * variable is a rejection rather than a silently ignored field.
 */
export interface NotificationTemplate<TSchemaType extends TSchema = TSchema> {
  readonly key: NotificationTemplateKey;
  readonly version: number;
  readonly locale: NotificationLocale;
  readonly schema: TSchemaType;
  /** Whether rendering requires a raw secret. Checked before resolution. */
  readonly secretBearing: boolean;
  readonly render: (
    input: Static<TSchemaType>,
    context: RenderContext,
  ) => Omit<EmailMessage, "destination">;
}

/**
 * A template with its model type erased, as the registry stores it.
 *
 * The erasure is not laziness. `render` is contravariant in its input, so a
 * `NotificationTemplate<SigningInvitationModel>` is genuinely NOT a
 * `NotificationTemplate<TSchema>` — a heterogeneous registry cannot be typed
 * any other way without an unsound cast at every lookup instead of one here.
 *
 * `defineTemplate` is the only way to produce one, and it validates before it
 * casts, so the `unknown` never reaches a template body unchecked.
 */
export interface AnyNotificationTemplate {
  readonly key: NotificationTemplateKey;
  readonly version: number;
  readonly locale: NotificationLocale;
  readonly schema: TSchema;
  readonly secretBearing: boolean;
  readonly render: (
    input: unknown,
    context: RenderContext,
  ) => Omit<EmailMessage, "destination">;
}

/**
 * Declares a template with a typed model and erases it for the registry.
 *
 * The cast inside is safe because every caller of `render` — the registry, and
 * therefore everything else — validates against `schema` immediately before
 * invoking it. A template body never sees an unvalidated model.
 */
export function defineTemplate<TSchemaType extends TSchema>(
  template: NotificationTemplate<TSchemaType>,
): AnyNotificationTemplate {
  // `Static<TSchemaType>` widens to `unknown` for a generic schema, so no cast
  // is needed here -- and adding one would be the kind of assertion that stops
  // being checked the day the generic is narrowed.
  return { ...template, render: template.render };
}

export class TemplateNotFoundError extends Error {
  constructor(readonly ref: NotificationTemplateRef) {
    super(`No template registered for ${ref.key} v${ref.version}`);
    this.name = "TemplateNotFoundError";
  }
}

export class TemplateInputError extends Error {
  constructor(readonly ref: NotificationTemplateRef, message: string) {
    super(message);
    this.name = "TemplateInputError";
  }
}

export class MissingSecretError extends Error {
  constructor(readonly ref: NotificationTemplateRef) {
    super(`Template ${ref.key} v${ref.version} requires a secret and none was resolved`);
    this.name = "MissingSecretError";
  }
}

const refKey = (ref: NotificationTemplateRef): string => `${ref.key}@${ref.version}`;

export interface NotificationTemplateRegistry {
  /** The template, or a throw. Never a fallback to another version. */
  get(ref: NotificationTemplateRef): AnyNotificationTemplate;
  has(ref: NotificationTemplateRef): boolean;
  /**
   * The newest registered version of a key.
   *
   * For CREATING an intent only. Never for rendering one: a pending intent
   * carries its own version and asking for the current one at send time is the
   * exact substitution S59 forbids.
   */
  currentVersion(key: NotificationTemplateKey): number;
  /** Validates a candidate input against a template's schema. */
  validateInput(
    ref: NotificationTemplateRef,
    input: NotificationTemplateInput,
  ): void;
  /** Renders a frozen input into a message body. */
  render(
    ref: NotificationTemplateRef,
    input: NotificationTemplateInput,
    context: RenderContext,
  ): Omit<EmailMessage, "destination">;
}

export function createTemplateRegistry(
  templates: readonly AnyNotificationTemplate[],
): NotificationTemplateRegistry {
  const byRef = new Map<string, AnyNotificationTemplate>();
  const newestByKey = new Map<NotificationTemplateKey, number>();

  for (const template of templates) {
    const key = refKey(template);
    if (byRef.has(key)) {
      // Two templates claiming one version would make rendering depend on
      // registration order, and a frozen ref would no longer identify one body
      // of copy.
      throw new Error(`Duplicate template registration: ${key}`);
    }
    byRef.set(key, template);
    newestByKey.set(
      template.key,
      Math.max(newestByKey.get(template.key) ?? 0, template.version),
    );
  }

  const get = (ref: NotificationTemplateRef): AnyNotificationTemplate => {
    const template = byRef.get(refKey(ref));
    if (template === undefined) throw new TemplateNotFoundError(ref);
    return template;
  };

  const validateInput = (
    ref: NotificationTemplateRef,
    input: NotificationTemplateInput,
  ): void => {
    const { schema } = get(ref);
    if (!Value.Check(schema, input)) {
      const [firstError] = [...Value.Errors(schema, input)];
      throw new TemplateInputError(
        ref,
        firstError === undefined
          ? "Template input failed validation"
          : `Template input invalid at ${firstError.path || "/"}: ${firstError.message}`,
      );
    }
  };

  return {
    get,
    has: ref => byRef.has(refKey(ref)),
    currentVersion: key => {
      const version = newestByKey.get(key);
      if (version === undefined) throw new Error(`No template registered for ${key}`);
      return version;
    },
    validateInput,
    render: (ref, input, context) => {
      const template = get(ref);
      // Validated again at render time, not only at creation. The row being
      // rendered may have been written by a previous deployment.
      validateInput(ref, input);
      if (template.secretBearing && context.secret === null) {
        throw new MissingSecretError(ref);
      }
      const message = template.render(input, context);
      return {
        subject: assertSafeSubject(message.subject),
        textBody: assertBoundedBody(message.textBody),
        ...(message.htmlBody === undefined
          ? {}
          : { htmlBody: assertBoundedBody(message.htmlBody) }),
      };
    },
  };
}

// ── Shared model fragments ───────────────────────────────────────────────────

/**
 * Bounded strings, because a template model is persisted as JSONB (S180).
 *
 * The DB column has no length opinion, so the schema is where "a document title
 * is at most 300 characters" is actually enforced — and it is enforced at
 * creation, before the row exists, rather than discovered at render time when
 * the message is already owed to somebody.
 */
const BoundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** A display name for a person or workspace. Never an address. */
const DisplayName = BoundedText(200);

export const AccountEmailVerificationModelV1 = Type.Object(
  { recipientName: DisplayName },
  { additionalProperties: false },
);

export const PasswordResetModelV1 = Type.Object(
  { recipientName: DisplayName },
  { additionalProperties: false },
);

export const MfaOtpModelV1 = Type.Object(
  { recipientName: DisplayName },
  { additionalProperties: false },
);

export const WorkspaceInvitationModelV1 = Type.Object(
  {
    inviterDisplayName: DisplayName,
    workspaceName: DisplayName,
  },
  { additionalProperties: false },
);

export const SigningInvitationModelV1 = Type.Object(
  {
    recipientName: DisplayName,
    documentTitle: BoundedText(300),
    senderDisplayName: DisplayName,
    workspaceName: DisplayName,
  },
  { additionalProperties: false },
);
