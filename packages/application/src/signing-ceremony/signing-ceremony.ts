// The signing ceremony (BACKEND-35).
//
// ── What this turns into what ──────────────────────────────────────────────
//
//   recipient session cookie
//        -> RecipientSigningContext (BACKEND-34)
//        -> enterWorkspace(workspace, request, recipient) on the SAME transaction
//        -> the immutable request snapshot, this recipient's row, this
//           recipient's fields, the exact source artifact
//        -> a recipient-scoped ceremony projection
//
// ── Three things it never does ─────────────────────────────────────────────
//
// It never reads a Contact, a DocumentPreparation, a PreparationField or the
// document's CURRENT artifact. The ceremony repository has no method for any
// of them, so this is a property of the type rather than a rule to follow.
//
// It never accepts an identity from the caller. The request and the recipient
// come from the session; a route that carries a request id in its path
// compares it and refuses a mismatch rather than trusting it.
//
// It never signs anything. Entering is not viewing, viewing is not consenting,
// consenting is not signing, and none of them advances routing.

import type { WorkspaceId, TransactionId } from "@lagda/contracts";
import type { EvidenceEventIdGenerator } from "../common/ports/index.js";
// BACKEND-43. Factories, never hand-built event literals.
import { ceremonyEntered, consentAccepted } from "../evidence/events.js";
import type { PreparationFieldType } from "@lagda/contracts";
import {
  assessCeremonyAccess, orderCeremonyFields, fieldInputPolicy,
  CEREMONY_CONSENT_TYPE,
  type CeremonyAccess, type CeremonyBlocker,
  type FieldValueAuthority, type FieldValueKind,
} from "@lagda/core";
import type {
  Clock, TransactionManager,
  SigningRequestId, SigningRequestRecipientId,
  RecipientSessionTokenFactory, RecipientSigningSessionId,
  RecipientAuthenticationMethod, SigningConsentIdGenerator,
  RecipientCeremonyUnitOfWork, RecipientCeremonyRepository,
  CeremonyArtifactRecord,
} from "../common/ports/index.js";
import type { ObjectStorage, ByteStream } from "../common/ports/storage.js";
import type { RecipientType } from "@lagda/core";
import { ApplicationError } from "../common/errors/index.js";
import {
  resolveRecipientSession, RecipientSessionInvalidError,
  type RecipientSigningContext, type SigningAccessDependencies,
} from "../signing-access/signing-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The ceremony cannot be entered right now, and the recipient is TOLD why.
 *
 * ── Deliberately not collapsed, unlike BACKEND-34 ──────────────────────────
 *
 * A bootstrap caller holds a credential that may have been stolen, so every
 * failure there returns one indistinguishable error. A ceremony caller has
 * already authenticated as this specific recipient of this specific request.
 * Telling them "the sender cancelled this" or "you are waiting for an earlier
 * signer" discloses nothing they are not entitled to, and withholding it
 * produces a product where a legitimate signer stares at a blank refusal.
 *
 * The vocabulary is bounded (three values) so the reason can never widen into
 * a free-text leak.
 */
export class SigningCeremonyUnavailableError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_ceremony_unavailable";
  constructor(readonly blocker: CeremonyBlocker) {
    super(`The signing ceremony is not available: ${blocker}.`);
  }
}

/** The request's frozen artifact is missing or unreadable. Never a fallback. */
export class SigningDocumentUnavailableError extends ApplicationError {
  readonly category = "dependency-unavailable" as const;
  readonly code = "signing_document_unavailable";
  constructor() {
    super("The signing document is temporarily unavailable.");
  }
}

/**
 * The snapshot a ceremony depends on is not there.
 *
 * Distinct from `SigningCeremonyUnavailableError` because it is not a state a
 * request can legitimately be in: a valid session names a request, a recipient
 * and their fields, and any of them missing is an integrity failure worth
 * alerting on rather than a workflow condition worth explaining (§205, §206).
 */
export class SigningCeremonySnapshotError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_ceremony_snapshot_invalid";
  constructor(what: string) {
    super(`The signing request snapshot is incomplete: ${what}.`);
  }
}

/** Consent was submitted for a version the ceremony is not asking for. */
export class SigningConsentVersionMismatchError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "signing_consent_version_mismatch";
  constructor() {
    super("That consent version is not the one currently required.");
  }
}

/** Consent was submitted by a recipient the disclosure does not apply to. */
export class SigningConsentNotRequiredError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_consent_not_required";
  constructor() {
    super("This recipient is not asked to accept an electronic signature disclosure.");
  }
}

// ── The projection ───────────────────────────────────────────────────────────

/**
 * One field, as a recipient may see it.
 *
 * Geometry is passed through UNCHANGED — normalized 0–1, top-left origin, `y`
 * to the field's top, 1-based pages. §109 forbids transforming to viewport
 * pixels here, and the frontend already multiplies by its own page size
 * (`DocumentReviewPage.tsx:89`), so a backend transform would be a second,
 * conflicting source of truth about where a signature goes.
 *
 * The three policy fields are echoed from `FIELD_INPUT_POLICY` so the frontend
 * can disable an input it must not collect — a `date-signed` box is rendered
 * but its value is the server's.
 */
export interface CeremonyFieldView {
  readonly fieldId: string;
  readonly type: PreparationFieldType;
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
  readonly valueAuthority: FieldValueAuthority;
  readonly valueKind: FieldValueKind;
  readonly maxLength: number | null;
}

/**
 * What a recipient may know about the document, short of its bytes.
 *
 * No storage key, no bucket, no URL, no internal path. `digest` is the
 * request's frozen content digest and is included because a ceremony that can
 * show an integrity identifier is strictly better than one that cannot — the
 * recipient can prove later that they were shown these exact bytes.
 */
export interface CeremonyDocumentView {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: string;
  /** `null` for artifacts inspected before page counting existed. */
  readonly pageCount: number | null;
}

export interface CeremonyConsentView {
  readonly required: boolean;
  readonly accepted: boolean;
  readonly type: string;
  /** The version the ceremony is asking for right now. */
  readonly requiredVersion: string;
  /** The version actually accepted, when one was. */
  readonly acceptedVersion: string | null;
  readonly acceptedAt: number | null;
}

/**
 * The complete recipient-facing ceremony.
 *
 * ── What is NOT in here, and why ───────────────────────────────────────────
 *
 * No other recipient — not a name, not an email, not a count, not a status.
 * No sender user, no workspace name, no capabilities, no delivery state, no
 * grant or session identifier, no idempotency metadata (§98, §99, §154).
 *
 * No sender/workspace display name even though `SignPage` shows one: nothing
 * snapshotted it at send, and reading the workspace's CURRENT name would both
 * widen the recipient realm and make ceremony history depend on a mutable
 * value. Recorded as a gap rather than filled from the wrong source (§101).
 */
export interface SigningCeremonyView {
  readonly request: {
    readonly signingRequestId: SigningRequestId;
    /** The title AS IT WAS at request creation. Not the document's today. */
    readonly documentTitle: string;
  };
  readonly recipient: {
    readonly recipientId: SigningRequestRecipientId;
    readonly name: string;
    /** Their OWN delivery address, from the immutable snapshot. Still PII. */
    readonly email: string;
    readonly type: RecipientType;
  };
  readonly access: CeremonyAccess;
  readonly consent: CeremonyConsentView;
  /** `null` until consent is satisfied — the product gates the document. */
  readonly document: CeremonyDocumentView | null;
  /** Empty until consent is satisfied. Ordered for reading. */
  readonly fields: readonly CeremonyFieldView[];
  /** Set once, on the first explicit entry. `null` before that. */
  readonly firstEnteredAt: number | null;
}

/** An open byte stream for the request's exact source artifact. */
export interface RecipientDocumentStream {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly stream: ByteStream;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface CeremonyConsentPolicy {
  /**
   * The disclosure version the ceremony currently requires.
   *
   * System policy rather than per-request, because nothing snapshots a
   * per-request choice — the immutable recipient row has no consent column and
   * adding one is a BACKEND-32 change. §141 permits either, provided the
   * lifecycle point is clear, and this one is: the version configured when the
   * ceremony is presented.
   *
   * The consequence, stated rather than hidden: rotating the version asks
   * already-accepted recipients again, because the new disclosure says
   * something different and their old acceptance is evidence of agreeing to
   * the old one. OPEN_DECISIONS records freezing per request as the
   * alternative for when legal copy actually rotates.
   */
  readonly consentVersion: string;
}

export interface SigningCeremonyDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly sessionTokens: RecipientSessionTokenFactory;
  readonly consentIds: SigningConsentIdGenerator;
  /** BACKEND-43. Evidence ids for the two events this module now appends. */
  readonly ids: EvidenceEventIdGenerator;
  readonly storage: ObjectStorage;
  readonly policy: CeremonyConsentPolicy;
}

/** The subset `resolveRecipientSession` needs. */
type SessionDeps = Pick<
  SigningAccessDependencies, "transactions" | "clock" | "sessionTokens"
>;

// ── Shared resolution ────────────────────────────────────────────────────────

/**
 * Everything both read paths need, computed once.
 *
 * `record` is the one place the snapshot is read, so "the ceremony is derived
 * only from immutable rows" is checkable by reading a single function.
 */
async function buildCeremonyView(
  uow: RecipientCeremonyUnitOfWork,
  context: RecipientSigningContext,
  deps: SigningCeremonyDependencies,
  firstEnteredAtOverride: number | null,
): Promise<SigningCeremonyView> {
  const ceremony: RecipientCeremonyRepository = uow.ceremony;

  const request = await ceremony.getRequest();
  if (request === null) throw new SigningCeremonySnapshotError("request missing");
  const recipient = await ceremony.getRecipient();
  if (recipient === null) throw new SigningCeremonySnapshotError("recipient missing");

  const activationState = await ceremony.getActivationState();
  const consents = await ceremony.listConsents();
  const requiredVersion = deps.policy.consentVersion;

  // An acceptance only counts for the version currently being asked for. §140.
  const matching = consents.find(
    c => c.consentType === CEREMONY_CONSENT_TYPE
      && c.consentVersion === requiredVersion,
  ) ?? null;

  const access = assessCeremonyAccess({
    requestState: request.state,
    recipientState: activationState,
    recipientType: recipient.type,
    consentAccepted: matching !== null,
  });

  if (!access.mayEnter) {
    // `blocker` is non-null exactly when `mayEnter` is false, but the type
    // cannot say so — a default keeps this total without inventing a reason.
    throw new SigningCeremonyUnavailableError(access.blocker ?? "recipient-cannot-act");
  }

  // Document and fields are withheld until consent is satisfied, which is the
  // product's own ordering rather than an added restriction.
  let document: CeremonyDocumentView | null = null;
  let fields: readonly CeremonyFieldView[] = [];

  if (access.mayViewDocument) {
    const artifact = await ceremony.getSourceArtifact();
    if (artifact === null) throw new SigningCeremonySnapshotError("source artifact missing");
    document = toDocumentView(artifact);
  }
  if (access.mayViewAssignedFields) {
    const assigned = await ceremony.listAssignedFields();
    fields = orderCeremonyFields(
      assigned.map(f => ({ ...f, requestFieldId: f.fieldId })),
    ).map(toFieldView);
  }

  const progress = firstEnteredAtOverride === null
    ? await ceremony.getProgress()
    : { firstEnteredAt: firstEnteredAtOverride };

  return {
    request: {
      signingRequestId: request.signingRequestId,
      documentTitle: request.documentTitle,
    },
    recipient: {
      recipientId: recipient.recipientId,
      name: recipient.name,
      email: recipient.email,
      type: recipient.type,
    },
    access,
    consent: {
      required: access.consentRequired,
      accepted: matching !== null,
      type: CEREMONY_CONSENT_TYPE,
      requiredVersion,
      acceptedVersion: matching?.consentVersion ?? null,
      acceptedAt: matching?.acceptedAt ?? null,
    },
    document,
    fields,
    firstEnteredAt: progress?.firstEnteredAt ?? null,
  };
}

function toDocumentView(artifact: CeremonyArtifactRecord): CeremonyDocumentView {
  return {
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    digest: artifact.digest,
    pageCount: artifact.pageCount,
  };
}

function toFieldView(
  field: {
    readonly fieldId: string; readonly type: PreparationFieldType;
    readonly pageNumber: number; readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
    readonly required: boolean; readonly label: string; readonly layer: number;
  },
): CeremonyFieldView {
  const policy = fieldInputPolicy(field.type);
  return {
    fieldId: field.fieldId,
    type: field.type,
    pageNumber: field.pageNumber,
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    required: field.required,
    label: field.label,
    layer: field.layer,
    valueAuthority: policy.authority,
    valueKind: policy.valueKind,
    maxLength: policy.maxLength,
  };
}

async function withCeremony<T>(
  rawSessionToken: string,
  deps: SigningCeremonyDependencies,
  operation: (
    uow: RecipientCeremonyUnitOfWork, context: RecipientSigningContext,
  ) => Promise<T>,
): Promise<T> {
  const sessionDeps: SessionDeps = {
    transactions: deps.transactions,
    clock: deps.clock,
    sessionTokens: deps.sessionTokens,
  };
  const context = await resolveRecipientSession(
    rawSessionToken, sessionDeps as SigningAccessDependencies,
  );

  const digest = deps.sessionTokens.digestToken(rawSessionToken);
  if (digest === null) throw new RecipientSessionInvalidError();

  return deps.transactions.runForRecipientSession(digest, async sessionUow =>
    sessionUow.enterWorkspace(
      {
        workspaceId: context.workspaceId,
        signingRequestId: context.signingRequestId,
        recipientId: context.recipientId,
      },
      uow => operation(uow, context),
    ));
}

// ── Use cases ────────────────────────────────────────────────────────────────

/**
 * Records that this recipient began signing, and returns the ceremony.
 *
 * ── Why a POST and not a GET side effect ───────────────────────────────────
 *
 * §189 puts the choice plainly and §190 states the preference: an explicit
 * POST keeps the evidence-producing act separate from reading. A GET that
 * silently writes a first-entry timestamp is the kind of thing that is fine
 * until a browser prefetches it.
 *
 * It returns the projection so the frontend needs one round trip, not two
 * (§193).
 *
 * ── Why repeated entry is safe ─────────────────────────────────────────────
 *
 * `insert … on conflict do nothing`. The first call wins, every later call
 * reads the same timestamp back, and two concurrent calls converge without a
 * lock. A reload is not a second entry, and the row cannot be updated by any
 * statement the runtime role can issue.
 */
export async function enterSigningCeremony(
  rawSessionToken: string,
  deps: SigningCeremonyDependencies,
): Promise<SigningCeremonyView> {
  return withCeremony(rawSessionToken, deps, async (uow, context) => {
    // Build FIRST. It throws when the request is not signable or routing has
    // not reached this recipient, and a refused entry must leave no trace —
    // otherwise a waiting recipient's reload would record them as having
    // begun.
    const preliminary = await buildCeremonyView(uow, context, deps, null);

    const now = deps.clock.now();
    await uow.ceremony.recordFirstEntry({ firstEnteredAt: now, createdAt: now });

    // Read it back rather than assuming this call won. Under concurrency the
    // authoritative timestamp may be the other call's.
    const progress = await uow.ceremony.getProgress();
    const firstEnteredAt = progress?.firstEnteredAt ?? now;

    // ── Evidence (BACKEND-43 §151) ────────────────────────────────────────
    //
    // Stamped with the AUTHORITATIVE first-entry time, not `now` — under
    // concurrency the winning timestamp may be another call's, and an event
    // claiming this call's clock would disagree with the progress row.
    //
    // Appended unconditionally: the event is sourced by the recipient, so the
    // partial unique index refuses every entry after the first. That is what
    // keeps a reload from filling the timeline (§93) rather than a check here,
    // which two concurrent entries would both pass.
    //
    // A duplicate is therefore EXPECTED on re-entry and must not fail the
    // request — the recipient did nothing wrong by reloading.
    try {
      await uow.evidence.append(ceremonyEntered({
        newEventId: () => deps.ids.nextEvidenceEventId(),
        signingRequestId: uow.signingRequestId as unknown as TransactionId,
        occurredAt: firstEnteredAt,
      }, uow.recipientId));
    } catch {
      // Already recorded. The first entry is the fact and it is already there.
    }

    return { ...preliminary, firstEnteredAt };
  });
}

/**
 * The ceremony as it stands. Pure read — no write, no event, no state change.
 *
 * Revalidates signability on every call. A session says who is asking; it
 * never says the request is still signable, and a cookie that outlived a
 * cancellation must not keep working (§12, §120, §121).
 */
export async function getSigningCeremony(
  rawSessionToken: string,
  deps: SigningCeremonyDependencies,
): Promise<SigningCeremonyView> {
  return withCeremony(rawSessionToken, deps, (uow, context) =>
    buildCeremonyView(uow, context, deps, null));
}

/**
 * Opens the exact bytes the request froze.
 *
 * ── Streamed, because the storage port cannot presign ──────────────────────
 *
 * §24 offers streaming or a presigned URL and §25 leans presigned — but
 * `ObjectStorage` has four operations, and none of them mints a URL. Adding
 * presigning would mean a new port operation, a provider capability and a
 * bearer credential with a TTL to get right. Streaming needs none of that, and
 * every byte stays behind an authorization this backend performs itself.
 *
 * ── The transaction is closed before any byte moves ────────────────────────
 *
 * Authorization and metadata come out of `withCeremony`, which commits. The
 * storage call happens after. §90 and §144 require exactly this: a PDF
 * transfer must never hold a database connection open.
 */
export async function getRecipientSigningDocument(
  rawSessionToken: string,
  deps: SigningCeremonyDependencies,
): Promise<RecipientDocumentStream> {
  const artifact = await withCeremony(rawSessionToken, deps, async (uow, context) => {
    const view = await buildCeremonyView(uow, context, deps, null);
    // Consent gates the document, so a recipient who has not accepted cannot
    // reach the bytes by calling this endpoint directly.
    if (!view.access.mayViewDocument) {
      throw new SigningCeremonyUnavailableError("recipient-cannot-act");
    }
    const record = await uow.ceremony.getSourceArtifact();
    if (record === null) throw new SigningCeremonySnapshotError("source artifact missing");
    return record;
  });

  const content = await deps.storage.getObject({
    zone: "artifacts",
    key: artifact.storageReference,
  });
  // Missing bytes are an integrity failure, never a reason to serve something
  // else. There is no fallback artifact and there must not be one (§204).
  if (content === null) throw new SigningDocumentUnavailableError();

  return {
    // The artifact record's validated media type, not the provider's echo.
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    digest: artifact.digest,
    stream: content.stream,
  };
}

/**
 * Accepts the electronic-records-and-signature disclosure.
 *
 * ── What acceptance is, and is not ─────────────────────────────────────────
 *
 * It is: this recipient, on this request, agreed to THIS disclosure version at
 * a time the backend clock recorded.
 *
 * It is not authentication (that already happened), and it is not a signature
 * (nothing has been signed). It unlocks the document and the fields; it puts
 * nothing on the page.
 *
 * ── What the client may send ───────────────────────────────────────────────
 *
 * One value: the version it is accepting. Not a recipient id, not a request
 * id, not a timestamp, not a user id — all of those come from the session or
 * the clock. The version is checked against what the ceremony is asking for,
 * so a client cannot accept an obsolete disclosure it was never shown (§140).
 */
export async function acceptSigningConsent(
  rawSessionToken: string,
  input: { readonly consentVersion: string },
  deps: SigningCeremonyDependencies,
): Promise<SigningCeremonyView> {
  return withCeremony(rawSessionToken, deps, async (uow, context) => {
    const before = await buildCeremonyView(uow, context, deps, null);

    if (!before.consent.required) throw new SigningConsentNotRequiredError();
    if (input.consentVersion !== before.consent.requiredVersion) {
      throw new SigningConsentVersionMismatchError();
    }

    const now = deps.clock.now();
    // Returns false when this version was already accepted. That is a retry,
    // not a conflict, and the unique constraint is what makes two concurrent
    // acceptances converge on one row (§137, §139).
    const consentId = deps.consentIds.nextSigningConsentId();
    const inserted = await uow.ceremony.insertConsent({
      consentId,
      consentType: CEREMONY_CONSENT_TYPE,
      consentVersion: before.consent.requiredVersion,
      acceptedAt: now,
      signingSessionId: context.signingSessionId,
      authenticationMethod: context.authenticationMethod,
      createdAt: now,
    });

    // ── Evidence (BACKEND-43 §152) ────────────────────────────────────────
    //
    // ONLY when this call actually inserted. On a retry `insertConsent` returns
    // false and the existing row keeps its ORIGINAL consent id — appending here
    // would mint an event sourced from an id no consent row has, which the
    // unique index cannot deduplicate against the first. The retry would append
    // a second consent event every time.
    //
    // This is the one place in the command where idempotency cannot be left to
    // the database, because the source id itself differs between attempts.
    if (inserted) {
      await uow.evidence.append(consentAccepted({
        newEventId: () => deps.ids.nextEvidenceEventId(),
        signingRequestId: uow.signingRequestId as unknown as TransactionId,
        occurredAt: now,
      }, uow.recipientId, consentId,
      CEREMONY_CONSENT_TYPE, before.consent.requiredVersion));
    }

    // Rebuild: consent changes what may be seen, so the caller gets the
    // document and fields in the same response that accepted the disclosure.
    return buildCeremonyView(uow, context, deps, before.firstEnteredAt);
  });
}

/**
 * Deliberately absent from this module.
 *
 * **Signature and field values.** No table, no port, no validation path. The
 * product holds in-progress input in memory and says so twice; a draft store
 * would have no writer and would create partial signing state nobody asked
 * for (§65, §67).
 *
 * **Decline.** The UI has a decline button and BACKEND-35 excludes it by name.
 *
 * **Routing advancement.** Nothing here activates the next recipient. Viewing
 * and consenting are not completion (§174).
 *
 * **Evidence events.** `evidence_events` exists and NO use case in this
 * codebase writes one — not request creation, not send. Writing the first one
 * here would produce a trail with a hole in the middle. The authoritative
 * facts this command persists live in `signing_recipient_progress` and
 * `signing_recipient_consents`, which are append-only and privilege-locked.
 * Wiring the lifecycle into evidence is one cross-cutting command's job.
 *
 * **Notification.** Nobody is told the recipient looked (§175).
 */
export type SigningCeremonyOperationsDeferred = never;

export type { RecipientSigningSessionId, RecipientAuthenticationMethod, WorkspaceId };
