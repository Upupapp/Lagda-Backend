// Recipient signing access, tested with fakes.
//
// The claims that carry weight:
//
//   a credential resolves ONE grant and validates five conditions;
//
//   the session credential is FRESH — not the bootstrap token, not derived
//   from it;
//
//   a session is bound to one request and one recipient, and matching emails
//   do not widen it;
//
//   nothing a recipient DOES is recorded — no viewed, no consent, no signature.

import { describe, it, expect } from "vitest";
import type { DocumentId, UserId, WorkspaceId } from "@lagda/contracts";
import {
  bootstrapSigningAccess, resolveRecipientSession, validateRecipientCsrf,
  maskEmail,
  SigningLinkInvalidOrExpiredError, SigningAccessNotActiveError,
  RecipientSessionInvalidError,
  type SigningAccessDependencies,
} from "./signing-access.js";
import type {
  ArtifactId, SigningRequestId, SigningRequestRecipientId,
  SigningAccessGrantId, SigningAccessDigest,
  RecipientSessionDigest, RecipientCsrfDigest,
} from "../common/ports/index.js";
import {
  FixedClock, SequentialRecipientSessionIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const SESSION_LIFETIME = 8 * 3_600_000;
const WS = "ws_1" as WorkspaceId;
const OTHER_WS = "ws_2" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const OTHER_REQUEST = "sr_2" as SigningRequestId;
const RECIPIENT = "srr_1" as SigningRequestRecipientId;
const OTHER_RECIPIENT = "srr_2" as SigningRequestRecipientId;

/** 43 base64url characters, the real encoded shape. */
const RAW = "boot".padEnd(43, "x");
const OTHER_RAW = "othr".padEnd(43, "y");

/**
 * Deterministic token factories.
 *
 * Every digest is 64 hex characters and shares NO substring with its raw
 * value — the shape a real SHA-256 has. BACKEND-33's suite learned this the
 * hard way: a double whose digest embedded its plaintext made a
 * "never persists the raw value" assertion pass for the wrong reason.
 */
const DIGEST_OF = (raw: string) =>
  raw.slice(0, 4).charCodeAt(0).toString(16).padStart(64, "b") as SigningAccessDigest;

function bootstrapTokens() {
  return {
    issue: () => ({ raw: RAW, digest: "b".repeat(64) as SigningAccessDigest }),
    digest: (submitted: string) => {
      if (submitted.length !== 43) return null;
      if (!/^[A-Za-z0-9_-]{43}$/.test(submitted)) return null;
      // A stable non-embedding map: the first four characters pick the digest.
      return DIGEST_OF(submitted);
    },
  };
}

function sessionTokens() {
  let issued = 0;
  const of = (kind: string, raw: string) =>
    `${kind}${raw.slice(0, 6)}`.padStart(64, "c");
  return {
    issue: () => {
      issued += 1;
      const rawToken = `sess${String(issued)}`.padEnd(43, "s");
      const rawCsrfToken = `csrf${String(issued)}`.padEnd(43, "r");
      return {
        rawToken,
        tokenDigest: of("t", rawToken) as RecipientSessionDigest,
        rawCsrfToken,
        csrfDigest: of("x", rawCsrfToken) as RecipientCsrfDigest,
      };
    },
    digestToken: (submitted: string) =>
      submitted.length === 43
        ? (of("t", submitted) as RecipientSessionDigest)
        : null,
    digestCsrf: (submitted: string) =>
      submitted.length === 43 ? (of("x", submitted) as RecipientCsrfDigest) : null,
  };
}

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: SigningAccessDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  return {
    store,
    deps: {
      transactions,
      clock: new FixedClock(AT),
      bootstrapTokens: bootstrapTokens(),
      sessionTokens: sessionTokens(),
      ids: new SequentialRecipientSessionIds(),
      policy: { sessionLifetimeMs: SESSION_LIFETIME },
    },
  };
}

/** Seeds a request, a recipient, an activation row and a grant. */
function seed(
  h: Harness,
  over: {
    raw?: string;
    workspaceId?: WorkspaceId;
    signingRequestId?: SigningRequestId;
    recipientId?: SigningRequestRecipientId;
    state?: "draft" | "sent";
    activation?: "active" | "waiting" | "none";
    expiresAt?: number;
    email?: string;
  } = {},
): void {
  const workspaceId = over.workspaceId ?? WS;
  const signingRequestId = over.signingRequestId ?? REQUEST;
  const recipientId = over.recipientId ?? RECIPIENT;

  h.store.signingRequests.push({
    signingRequestId, workspaceId,
    documentId: "doc_1" as DocumentId,
    sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as never,
    sourcePreparationRevision: 2,
    state: over.state ?? "sent",
    completionReadyAt: null, terminatedAt: null,
    terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease",
    createdByUserId: "usr_owner" as UserId,
    createdAt: AT, updatedAt: AT,
  });
  h.store.signingRequestRecipients.push({
    recipientId, sourcePreparationRecipientId: null,
    name: "Maria Santos",
    email: over.email ?? "maria.santos@ayalaland.com.ph",
    normalizedEmail: (over.email ?? "maria.santos@ayalaland.com.ph").toLowerCase(),
    organization: null, type: "signer", isRequired: true,
    orderIndex: 0, routingOrder: 1,
  });
  const activation = over.activation ?? "active";
  if (activation !== "none") {
    h.store.activations.push({
      recipientId,
      state: activation,
      activatedAt: activation === "active" ? AT : null,
      signingRequestId: String(signingRequestId),
      signedAt: null, submissionId: null,
      declinedAt: null, declineReason: null,
    });
  }
  h.store.signingAccessGrants.push({
    grantId: `sag_${String(h.store.signingAccessGrants.length + 1)}` as SigningAccessGrantId,
    workspaceId, signingRequestId, recipientId,
    credentialDigest: DIGEST_OF(over.raw ?? RAW),
    createdAt: AT,
    expiresAt: over.expiresAt ?? AT + 14 * 24 * 3_600_000,
  });
}

const boot = (h: Harness, raw = RAW) => bootstrapSigningAccess(raw, h.deps);

// ── Bootstrap ────────────────────────────────────────────────────────────────

describe("bootstrap", () => {
  it("exchanges a valid credential for a session", async () => {
    const h = harness();
    seed(h);

    const result = await boot(h);
    expect(result.context.signingRequestId).toBe(REQUEST);
    expect(result.context.recipientId).toBe(RECIPIENT);
    expect(result.context.authenticationMethod).toBe("link-only");
    expect(h.store.recipientSessions).toHaveLength(1);
  });

  it("returns a masked address, never the full one", async () => {
    const h = harness();
    seed(h);
    const result = await boot(h);
    expect(result.view.maskedEmail).toBe("m***@ayalaland.com.ph");
    expect(JSON.stringify(result.view)).not.toContain("maria.santos@");
  });

  it("refuses a malformed credential before touching the database", async () => {
    const h = harness();
    seed(h);
    for (const bad of ["", "short", "!".repeat(43), "x".repeat(44)]) {
      await expect(bootstrapSigningAccess(bad, h.deps))
        .rejects.toBeInstanceOf(SigningLinkInvalidOrExpiredError);
    }
    expect(h.store.recipientSessions).toHaveLength(0);
  });

  it("refuses an unknown credential", async () => {
    const h = harness();
    seed(h);
    await expect(boot(h, OTHER_RAW))
      .rejects.toBeInstanceOf(SigningLinkInvalidOrExpiredError);
  });

  it("refuses an expired grant", async () => {
    const h = harness();
    seed(h, { expiresAt: AT - 1 });
    await expect(boot(h)).rejects.toBeInstanceOf(SigningLinkInvalidOrExpiredError);
    expect(h.store.recipientSessions).toHaveLength(0);
  });

  it("refuses a request that is not sent", async () => {
    // A DRAFT request must never be reachable from a link.
    const h = harness();
    seed(h, { state: "draft" });
    await expect(boot(h)).rejects.toBeInstanceOf(SigningLinkInvalidOrExpiredError);
  });

  it("refuses a recipient whose turn has not come", async () => {
    const h = harness();
    seed(h, { activation: "waiting" });
    await expect(boot(h)).rejects.toBeInstanceOf(SigningAccessNotActiveError);
    expect(h.store.recipientSessions).toHaveLength(0);
  });

  it("refuses a recipient with no activation row at all", async () => {
    // Not a state send produces. Treated as ineligible rather than permission.
    const h = harness();
    seed(h, { activation: "none" });
    await expect(boot(h)).rejects.toBeInstanceOf(SigningAccessNotActiveError);
  });

  it("collapses every failure except routing into one error", async () => {
    // A public endpoint that distinguished expired from unknown would tell an
    // attacker their guess was real.
    const h = harness();
    seed(h, { expiresAt: AT - 1 });
    const expired = await boot(h).catch((error: unknown) => error);
    const unknown = await boot(h, OTHER_RAW).catch((error: unknown) => error);
    expect((expired as Error).message).toBe((unknown as Error).message);
    expect((expired as { code: string }).code)
      .toBe((unknown as { code: string }).code);
  });

  it("is reusable — a second exchange mints a second independent session", async () => {
    const h = harness();
    seed(h);
    const first = await boot(h);
    const second = await boot(h);

    expect(second.context.signingSessionId)
      .not.toBe(first.context.signingSessionId);
    expect(second.credentials.rawSessionToken)
      .not.toBe(first.credentials.rawSessionToken);
    expect(h.store.recipientSessions).toHaveLength(2);
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe("the session credential", () => {
  it("is not the bootstrap credential and is not derived from it", async () => {
    const h = harness();
    seed(h);
    const result = await boot(h);

    expect(result.credentials.rawSessionToken).not.toBe(RAW);
    expect(result.credentials.rawSessionToken).not.toContain(RAW);
    expect(RAW).not.toContain(result.credentials.rawSessionToken);
  });

  it("differs from its own CSRF token", async () => {
    const h = harness();
    seed(h);
    const result = await boot(h);
    expect(result.credentials.rawCsrfToken)
      .not.toBe(result.credentials.rawSessionToken);
    const stored = h.store.recipientSessions[0];
    expect(stored?.csrfTokenDigest).not.toBe(stored?.tokenDigest);
  });

  it("is persisted only as a digest", async () => {
    const h = harness();
    seed(h);
    const result = await boot(h);

    const stored = JSON.stringify(h.store.recipientSessions[0]);
    expect(stored).not.toContain(result.credentials.rawSessionToken);
    expect(stored).not.toContain(result.credentials.rawCsrfToken);
    expect(stored).not.toContain(RAW);
  });

  it("records the exact method and the source grant", async () => {
    const h = harness();
    seed(h);
    await boot(h);
    const stored = h.store.recipientSessions[0];
    expect(stored?.authenticationMethod).toBe("link-only");
    expect(stored?.sourceGrantId).toBe("sag_1");
    expect(stored?.authenticatedAt).toBe(AT);
    expect(stored?.expiresAt).toBe(AT + SESSION_LIFETIME);
  });

  it("is not accepted as a bootstrap credential", async () => {
    // Realm separation at the credential level: a session token submitted to
    // bootstrap digests under a different domain and resolves nothing.
    const h = harness();
    seed(h);
    const result = await boot(h);
    await expect(bootstrapSigningAccess(result.credentials.rawSessionToken, h.deps))
      .rejects.toBeInstanceOf(SigningLinkInvalidOrExpiredError);
  });
});

// ── Session resolution ───────────────────────────────────────────────────────

describe("session resolution", () => {
  it("resolves an active session to its context", async () => {
    const h = harness();
    seed(h);
    const created = await boot(h);

    const context = await resolveRecipientSession(
      created.credentials.rawSessionToken, h.deps);
    expect(context.signingRequestId).toBe(REQUEST);
    expect(context.recipientId).toBe(RECIPIENT);
    expect(context.signingSessionId).toBe(created.context.signingSessionId);
  });

  it("carries no workspace role or membership", async () => {
    const h = harness();
    seed(h);
    const created = await boot(h);
    const context = await resolveRecipientSession(
      created.credentials.rawSessionToken, h.deps);

    const serialized = JSON.stringify(context);
    for (const absent of [
      "role", "membershipId", "userId", "capabilities", "capability",
    ]) {
      expect(serialized, `context carries ${absent}`).not.toContain(absent);
    }
  });

  it("refuses an unknown or malformed cookie", async () => {
    const h = harness();
    seed(h);
    for (const bad of ["", "nope", "z".repeat(43)]) {
      await expect(resolveRecipientSession(bad, h.deps))
        .rejects.toBeInstanceOf(RecipientSessionInvalidError);
    }
  });

  it("refuses an expired session", async () => {
    const h = harness();
    seed(h);
    const created = await boot(h);
    // The clock moves past the session's life.
    const later: SigningAccessDependencies = {
      ...h.deps, clock: new FixedClock(AT + SESSION_LIFETIME + 1),
    };
    await expect(resolveRecipientSession(
      created.credentials.rawSessionToken, later,
    )).rejects.toBeInstanceOf(RecipientSessionInvalidError);
  });

  it("does not re-check request state", async () => {
    // A session says WHO is asking. Whether the request is still signable is a
    // question each sensitive operation asks for itself — the eligibility must
    // not be cached in a cookie.
    const h = harness();
    seed(h);
    const created = await boot(h);
    const request = h.store.signingRequests[0];
    if (request === undefined) throw new Error("fixture");
    h.store.signingRequests[0] = { ...request, state: "draft" };

    const context = await resolveRecipientSession(
      created.credentials.rawSessionToken, h.deps);
    expect(context.signingRequestId).toBe(REQUEST);
  });
});

// ── Scope ────────────────────────────────────────────────────────────────────

describe("a session is bound to one request and one recipient", () => {
  it("binds to the recipient the grant named, not another with the same email", async () => {
    const h = harness();
    // Two recipients, SAME address, different requests.
    seed(h, { email: "shared@example.com" });
    seed(h, {
      raw: OTHER_RAW, signingRequestId: OTHER_REQUEST,
      recipientId: OTHER_RECIPIENT, email: "shared@example.com",
    });

    const first = await boot(h);
    const second = await boot(h, OTHER_RAW);

    expect(first.context.recipientId).toBe(RECIPIENT);
    expect(first.context.signingRequestId).toBe(REQUEST);
    expect(second.context.recipientId).toBe(OTHER_RECIPIENT);
    expect(second.context.signingRequestId).toBe(OTHER_REQUEST);
    // Two sessions, neither of which can act as the other.
    expect(first.context.signingSessionId)
      .not.toBe(second.context.signingSessionId);
  });

  it("resolves each session to only its own request", async () => {
    const h = harness();
    seed(h, { email: "shared@example.com" });
    seed(h, {
      raw: OTHER_RAW, signingRequestId: OTHER_REQUEST,
      recipientId: OTHER_RECIPIENT, email: "shared@example.com",
    });
    const first = await boot(h);
    const second = await boot(h, OTHER_RAW);

    expect((await resolveRecipientSession(
      first.credentials.rawSessionToken, h.deps)).signingRequestId).toBe(REQUEST);
    expect((await resolveRecipientSession(
      second.credentials.rawSessionToken, h.deps)).signingRequestId)
      .toBe(OTHER_REQUEST);
  });

  it("carries the workspace the GRANT resolved, never one supplied", async () => {
    const h = harness();
    seed(h, { workspaceId: OTHER_WS });
    const result = await boot(h);
    expect(result.context.workspaceId).toBe(OTHER_WS);
  });
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

describe("recipient CSRF", () => {
  it("accepts the session's own token", async () => {
    const h = harness();
    seed(h);
    const created = await boot(h);
    expect(await validateRecipientCsrf(
      created.credentials.rawSessionToken,
      created.credentials.rawCsrfToken, h.deps)).toBe(true);
  });

  it("refuses another session's token", async () => {
    const h = harness();
    seed(h);
    const first = await boot(h);
    const second = await boot(h);
    expect(await validateRecipientCsrf(
      first.credentials.rawSessionToken,
      second.credentials.rawCsrfToken, h.deps)).toBe(false);
  });

  it("refuses the session token submitted as its own CSRF token", async () => {
    // Separate digest domains: the same string digests differently, so this
    // cannot match even though it is a real credential.
    const h = harness();
    seed(h);
    const created = await boot(h);
    expect(await validateRecipientCsrf(
      created.credentials.rawSessionToken,
      created.credentials.rawSessionToken, h.deps)).toBe(false);
  });

  it("refuses a malformed token", async () => {
    const h = harness();
    seed(h);
    const created = await boot(h);
    expect(await validateRecipientCsrf(
      created.credentials.rawSessionToken, "nope", h.deps)).toBe(false);
  });
});

// ── Side effects ─────────────────────────────────────────────────────────────

describe("authenticating does nothing else", () => {
  it("records no viewed, consent, signature or completion", async () => {
    const h = harness();
    seed(h);
    await boot(h);

    // BACKEND-37 NARROWED THIS, and the narrowing is the point. It used to
    // search a JSON dump for the SUBSTRING "signedAt", which passed only
    // because no column of that name existed; once the workflow row gained one
    // it failed while nothing had actually been recorded. A key that is present
    // and null is not a fact, so the check is now on the VALUES.
    //
    // The claim being made is §144 and §251: AUTHENTICATION DOES NOT ADVANCE
    // ANYTHING. The request keeps its state, and no recipient signs or declines
    // by having proved who they are.
    for (const activation of h.store.activations) {
      expect(activation.state).not.toBe("signed");
      expect(activation.state).not.toBe("declined");
      expect(activation.signedAt).toBeNull();
      expect(activation.declinedAt).toBeNull();
    }
    for (const request of h.store.signingRequests) {
      expect(request.state).toBe("sent");
      expect(request.completionReadyAt).toBeNull();
    }
    expect(h.store.workflowIntents).toHaveLength(0);

    const everything = JSON.stringify({
      sessions: h.store.recipientSessions,
      recipients: h.store.signingRequestRecipients,
    });
    for (const absent of [
      "viewedAt", "viewed_at", "consentedAt", "signedAt", "declinedAt",
      "completedAt", "signatureValue", "fieldValue",
    ]) {
      expect(everything, `records ${absent}`).not.toContain(absent);
    }
  });

  it("does not consume the grant", async () => {
    const h = harness();
    seed(h);
    const before = JSON.stringify(h.store.signingAccessGrants);
    await boot(h);
    expect(JSON.stringify(h.store.signingAccessGrants)).toBe(before);
  });

  it("does not touch the immutable request snapshot", async () => {
    const h = harness();
    seed(h);
    const before = JSON.stringify({
      requests: h.store.signingRequests,
      recipients: h.store.signingRequestRecipients,
    });
    await boot(h);
    expect(JSON.stringify({
      requests: h.store.signingRequests,
      recipients: h.store.signingRequestRecipients,
    })).toBe(before);
  });

  it("writes no evidence event", async () => {
    const h = harness();
    seed(h);
    await boot(h);
    expect(h.store.evidence).toHaveLength(0);
  });
});

// ── Masking ──────────────────────────────────────────────────────────────────

describe("maskEmail", () => {
  it("keeps one character and the domain", () => {
    expect(maskEmail("maria.santos@ayalaland.com.ph"))
      .toBe("m***@ayalaland.com.ph");
    expect(maskEmail("a@b.com")).toBe("a***@b.com");
  });

  it("reveals nothing for a value with no address shape", () => {
    expect(maskEmail("notanemail")).toBe("***");
    expect(maskEmail("@nolocal.com")).toBe("***");
  });
});
