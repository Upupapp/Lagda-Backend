// Verify Document access by emailed code (083).
//
// The store here is an in-memory model of the PostgreSQL adapter's rules
// (supersede, attempt cap, expiry, grant scope); the integration suite proves
// the adapter itself holds them.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { WorkspaceId } from "@lagda/contracts";
import type {
  VerificationAccessStore, VerificationAccessCrypto, VerificationParticipantTarget,
  VerificationDetailsProjection,
} from "../common/ports/verification-access.js";
import type { NewNotificationIntent } from "../common/ports/notifications.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";
import {
  requestVerificationAccessCode, redeemVerificationAccessCode,
  grantMemberVerificationAccess, getVerificationAccessDetails,
  resolveVerificationAccessDocument, maskParticipantEmail, presentVerificationDetails,
  VERIFICATION_CODE_TTL_MS, VERIFICATION_GRANT_TTL_MS, VERIFICATION_CODE_MAX_ATTEMPTS,
  VerificationDocumentUnavailableError,
  type VerificationAccessDependencies, type VerificationAccount,
} from "./verification-access.js";

const ID = "LAGDA-VER-2026-A7bK9mQ2xZ";
const OTHER_ID = "LAGDA-VER-2026-Zz9Yy8Xx7W";
const EMAIL = "maria@example.com";
const T0 = Date.parse("2026-09-26T10:00:00.000Z");

const TARGET: VerificationParticipantTarget = {
  workspaceId: "ws_1" as WorkspaceId,
  signingRequestId: "txn_1",
  requestRecipientId: "srr_maria",
  recipientName: "Maria Santos",
  destination: "Maria@Example.com",
  recipientType: "approver",
  documentTitle: "Office Lease",
};

const PROJECTION: VerificationDetailsProjection = {
  documentTitle: "Office Lease",
  completedAt: T0 - 1000,
  sealedDigest: "b".repeat(64),
  participants: [
    { requestRecipientId: "srr_juan", name: "Juan Cruz", email: "juan@example.com",
      recipientType: "signer", routingOrder: 2, orderIndex: 0 },
    { requestRecipientId: "srr_maria", name: "Maria Santos", email: "maria@example.com",
      recipientType: "approver", routingOrder: 1, orderIndex: 0 },
    { requestRecipientId: "srr_cc", name: "Ana Reyes", email: "ana@example.org",
      recipientType: "cc", routingOrder: 3, orderIndex: 0 },
  ],
  events: [
    { eventType: "transaction-sent", recipientId: null, occurredAt: T0 - 5000 },
    { eventType: "document-viewed", recipientId: "srr_maria", occurredAt: T0 - 4500 },
    { eventType: "approval-completed", recipientId: "srr_maria", occurredAt: T0 - 4000 },
    { eventType: "document-viewed", recipientId: "srr_juan", occurredAt: T0 - 3000 },
    { eventType: "signature-completed", recipientId: "srr_juan", occurredAt: T0 - 2000 },
    { eventType: "submission-accepted", recipientId: "srr_juan", occurredAt: T0 - 2000 },
    { eventType: "transaction-completed", recipientId: null, occurredAt: T0 - 1000 },
  ],
};

interface Challenge {
  challengeId: string; verificationId: string; email: string; digest: string;
  attempts: number; expiresAt: number; consumed: boolean; superseded: boolean;
}
interface Grant { verificationId: string; digest: string; expiresAt: number; origin: string }

function memoryStore(participants: Record<string, VerificationParticipantTarget>) {
  const challenges: Challenge[] = [];
  const grants: Grant[] = [];
  const key = (id: string, email: string) => `${id}|${email}`;
  const store: VerificationAccessStore = {
    async issueChallenge(input, notify) {
      const target = participants[key(input.verificationId, input.normalizedEmail)];
      if (target === undefined) return false;
      for (const c of challenges) {
        if (c.verificationId === input.verificationId && c.email === input.normalizedEmail
          && !c.consumed && !c.superseded) c.superseded = true;
      }
      challenges.push({
        challengeId: input.challengeId, verificationId: input.verificationId,
        email: input.normalizedEmail, digest: input.codeDigest, attempts: 0,
        expiresAt: input.expiresAt, consumed: false, superseded: false,
      });
      await notify(target, notifications as never, "trx");
      return true;
    },
    redeemChallenge(input) {
      const target = participants[key(input.verificationId, input.normalizedEmail)];
      const live = challenges.find(c => c.verificationId === input.verificationId
        && c.email === input.normalizedEmail && !c.consumed && !c.superseded);
      if (target === undefined || live === undefined) return Promise.resolve({ outcome: "denied" as const });
      if (live.expiresAt <= input.now || live.attempts >= input.maxAttempts) {
        return Promise.resolve({ outcome: "denied" as const });
      }
      if (!input.matches(live.challengeId, live.digest)) {
        live.attempts += 1;
        return Promise.resolve({ outcome: "denied" as const });
      }
      live.consumed = true;
      grants.push({ verificationId: input.verificationId, digest: input.grant.tokenDigest,
        expiresAt: input.grant.expiresAt, origin: "code" });
      return Promise.resolve({ outcome: "granted" as const, target });
    },
    issueMemberGrant(input) {
      const target = participants[key(input.verificationId, input.normalizedEmail)];
      if (target === undefined) return Promise.resolve(null);
      grants.push({ verificationId: input.verificationId, digest: input.grant.tokenDigest,
        expiresAt: input.grant.expiresAt, origin: "member" });
      return Promise.resolve(target);
    },
    findDetails(input) {
      const grant = grants.find(g => g.digest === input.tokenDigest);
      if (grant === undefined || grant.verificationId !== input.verificationId
        || grant.expiresAt <= input.now) return Promise.resolve(null);
      return Promise.resolve({ ...PROJECTION, target: TARGET, expiresAt: grant.expiresAt });
    },
    findDocumentRef(input) {
      const grant = grants.find(g => g.digest === input.tokenDigest);
      if (grant === undefined || grant.verificationId !== input.verificationId
        || grant.expiresAt <= input.now) return Promise.resolve(null);
      return Promise.resolve({ storageReference: "ws/doc/sealed.pdf", mediaType: "application/pdf", sizeBytes: 3 });
    },
  };
  return { store, challenges, grants };
}

const created: NewNotificationIntent[] = [];
const notifications = {
  createIfAbsent: (intent: NewNotificationIntent) => {
    created.push(intent);
    return Promise.resolve({ outcome: "CREATED", intent, delivery: {} });
  },
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let codes: string[] = [];
let seq = 0;
const crypto: VerificationAccessCrypto = {
  newCode: () => codes.shift() ?? "000000",
  digestCode: (challengeId, code) => sha(`code:${challengeId}:${code}`),
  digestsEqual: (a, b) => a === b,
  sealCode: code => ({ sealed: `sealed(${code})`, keyVersion: "v1" }),
  issueGrantToken: () => {
    const raw = `tok${String(++seq).padStart(40, "0")}`;
    return { raw, digest: sha(`grant:${raw}`) };
  },
  digestGrantToken: raw => (raw.startsWith("tok") ? sha(`grant:${raw}`) : null),
  nextChallengeId: () => `vac_${++seq}`,
  nextGrantId: () => `vag_${++seq}`,
};

let now = T0;
let account: VerificationAccount | null = null;
let memory: ReturnType<typeof memoryStore>;
let stored: { stream: AsyncIterable<Uint8Array> } | null;

function deps(): VerificationAccessDependencies {
  return {
    store: memory.store,
    crypto,
    clock: { now: () => now },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    ids: {
      nextNotificationIntentId: () => `nint_${++seq}` as never,
      nextNotificationDeliveryId: () => `ndel_${++seq}` as never,
    },
    storage: { getObject: () => Promise.resolve(stored) } as never,
    currentAccount: () => Promise.resolve(account),
  };
}

beforeEach(() => {
  now = T0;
  codes = ["123456", "654321", "111111"];
  created.length = 0;
  account = null;
  stored = {
    // eslint-disable-next-line @typescript-eslint/require-await
    stream: (async function* () { yield new Uint8Array([1, 2, 3]); })(),
  };
  memory = memoryStore({ [`${ID}|${EMAIL}`]: TARGET });
});

describe("requesting a code", () => {
  it("answers identically for a participant, a stranger, a bad reference and a bad email", async () => {
    const answers = await Promise.all([
      requestVerificationAccessCode(ID, EMAIL, deps()),
      requestVerificationAccessCode(ID, "stranger@example.com", deps()),
      requestVerificationAccessCode("not-a-reference", EMAIL, deps()),
      requestVerificationAccessCode(ID, "not-an-email", deps()),
    ]);
    for (const answer of answers) {
      expect(answer).toEqual({ sent: true, expiresInSeconds: 600 });
    }
    // Only the participant got a challenge and an email.
    expect(memory.challenges).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it("creates a digest-only challenge that expires in ten minutes", async () => {
    await requestVerificationAccessCode(ID, "  Maria@Example.COM ", deps());
    const [challenge] = memory.challenges;
    expect(challenge?.email).toBe(EMAIL);
    expect(challenge?.expiresAt).toBe(T0 + VERIFICATION_CODE_TTL_MS);
    expect(challenge?.digest).not.toContain("123456");
    expect(challenge?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("emails the participant row's own address through the notification pipeline", async () => {
    await requestVerificationAccessCode(ID, EMAIL, deps());
    const [intent] = created;
    expect(intent).toMatchObject({
      notificationType: "VERIFICATION_ACCESS_CODE",
      template: { key: "verification-access-code", version: 1 },
      scope: { kind: "WORKSPACE", workspaceId: "ws_1" },
      audience: { kind: "SIGNING_REQUEST_RECIPIENT", signingRequestRecipientId: "srr_maria" },
      destination: "Maria@Example.com",
      templateInput: { recipientName: "Maria Santos", documentTitle: "Office Lease" },
      secretRef: { kind: "CHALLENGE", challengeId: memory.challenges[0]?.challengeId },
    });
    // The code never reaches the frozen model.
    expect(JSON.stringify(intent)).not.toContain("123456");
  });

  it("a resend supersedes the previous live challenge", async () => {
    await requestVerificationAccessCode(ID, EMAIL, deps());
    await requestVerificationAccessCode(ID, EMAIL, deps());
    expect(memory.challenges.map(c => c.superseded)).toEqual([true, false]);
    // The old code no longer works; the new one does.
    expect((await redeemVerificationAccessCode(ID, EMAIL, "123456", deps())).outcome).toBe("denied");
    expect((await redeemVerificationAccessCode(ID, EMAIL, "654321", deps())).outcome).toBe("granted");
  });
});

describe("redeeming a code", () => {
  beforeEach(async () => {
    await requestVerificationAccessCode(ID, EMAIL, deps());
  });

  it("grants a 30-minute token with the details, and consumes the challenge", async () => {
    const result = await redeemVerificationAccessCode(ID, EMAIL, " 123456 ", deps());
    expect(result.outcome).toBe("granted");
    if (result.outcome !== "granted") return;
    expect(result.expiresAt).toBe(T0 + VERIFICATION_GRANT_TTL_MS);
    expect(result.documentTitle).toBe("Office Lease");
    expect(result.recipientType).toBe("approver");
    expect(result.details.sealedDigest).toBe("b".repeat(64));
    // The stored grant is the digest, never the token.
    expect(memory.grants[0]?.digest).not.toBe(result.accessToken);
    expect(memory.challenges[0]?.consumed).toBe(true);
    // Consumed: a second use of the same code fails.
    expect((await redeemVerificationAccessCode(ID, EMAIL, "123456", deps())).outcome).toBe("denied");
  });

  it("denies a wrong code, and kills the challenge after five attempts", async () => {
    for (let i = 0; i < VERIFICATION_CODE_MAX_ATTEMPTS; i++) {
      expect((await redeemVerificationAccessCode(ID, EMAIL, "999999", deps())).outcome).toBe("denied");
    }
    expect(memory.challenges[0]?.attempts).toBe(5);
    // Even the right code is refused now.
    expect((await redeemVerificationAccessCode(ID, EMAIL, "123456", deps())).outcome).toBe("denied");
  });

  it("denies an expired code", async () => {
    now = T0 + VERIFICATION_CODE_TTL_MS;
    expect((await redeemVerificationAccessCode(ID, EMAIL, "123456", deps())).outcome).toBe("denied");
  });

  it("refuses malformed codes without spending an attempt", async () => {
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      expect((await redeemVerificationAccessCode(ID, EMAIL, code, deps())).outcome).toBe("denied");
    }
    expect(memory.challenges[0]?.attempts).toBe(0);
  });

  it("denies another address and another reference identically", async () => {
    const a = await redeemVerificationAccessCode(ID, "stranger@example.com", "123456", deps());
    const b = await redeemVerificationAccessCode(OTHER_ID, EMAIL, "123456", deps());
    const c = await redeemVerificationAccessCode("garbage", EMAIL, "123456", deps());
    expect(a).toEqual({ outcome: "denied" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe("using a grant", () => {
  async function token(): Promise<string> {
    await requestVerificationAccessCode(ID, EMAIL, deps());
    const result = await redeemVerificationAccessCode(ID, EMAIL, "123456", deps());
    if (result.outcome !== "granted") throw new Error("expected a grant");
    return result.accessToken;
  }

  it("returns details and the document while live", async () => {
    const accessToken = await token();
    expect((await getVerificationAccessDetails(ID, accessToken, deps())).outcome).toBe("granted");
    expect((await resolveVerificationAccessDocument(ID, accessToken, deps())).outcome).toBe("found");
  });

  it("expires after thirty minutes", async () => {
    const accessToken = await token();
    now = T0 + VERIFICATION_GRANT_TTL_MS;
    expect(await getVerificationAccessDetails(ID, accessToken, deps())).toEqual({ outcome: "denied" });
    expect(await resolveVerificationAccessDocument(ID, accessToken, deps())).toEqual({ outcome: "denied" });
  });

  it("is scoped to its own verification ID", async () => {
    const accessToken = await token();
    expect(await resolveVerificationAccessDocument(OTHER_ID, accessToken, deps()))
      .toEqual({ outcome: "denied" });
  });

  it("refuses an email or a malformed token outright", async () => {
    expect(await resolveVerificationAccessDocument(ID, EMAIL, deps())).toEqual({ outcome: "denied" });
    expect(await getVerificationAccessDetails(ID, "nope", deps())).toEqual({ outcome: "denied" });
  });

  it("reports missing stored bytes as a server-side fault, not a denial", async () => {
    const accessToken = await token();
    stored = null;
    await expect(resolveVerificationAccessDocument(ID, accessToken, deps()))
      .rejects.toBeInstanceOf(VerificationDocumentUnavailableError);
  });
});

describe("signed-in member access", () => {
  it("grants a verified participant account without a code", async () => {
    account = { normalizedEmail: EMAIL, emailVerified: true };
    const result = await grantMemberVerificationAccess("usr_1", ID, deps());
    expect(result.outcome).toBe("granted");
    expect(memory.grants[0]?.origin).toBe("member");
    expect(memory.challenges).toHaveLength(0);
  });

  it("denies an UNVERIFIED account even when its address matches", async () => {
    account = { normalizedEmail: EMAIL, emailVerified: false };
    expect(await grantMemberVerificationAccess("usr_1", ID, deps())).toEqual({ outcome: "denied" });
    expect(memory.grants).toHaveLength(0);
  });

  it("denies a verified account that is not a participant, or no account", async () => {
    account = { normalizedEmail: "other@example.com", emailVerified: true };
    expect(await grantMemberVerificationAccess("usr_1", ID, deps())).toEqual({ outcome: "denied" });
    account = null;
    expect(await grantMemberVerificationAccess("usr_1", ID, deps())).toEqual({ outcome: "denied" });
  });
});

describe("the details summary", () => {
  it("masks email as first character, bullets and the domain", () => {
    expect(maskParticipantEmail("juan@example.com")).toBe("j•••@example.com");
    expect(maskParticipantEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskParticipantEmail("no-at-sign")).toBe("•••");
  });

  it("orders participants by routing and derives status and time from evidence", () => {
    const view = presentVerificationDetails(PROJECTION);
    expect(view.participants).toEqual([
      { name: "Maria Santos", maskedEmail: "m•••@example.com", recipientType: "approver",
        status: "approved", actedAt: T0 - 4000, routingOrder: 1 },
      { name: "Juan Cruz", maskedEmail: "j•••@example.com", recipientType: "signer",
        status: "signed", actedAt: T0 - 2000, routingOrder: 2 },
      { name: "Ana Reyes", maskedEmail: "a•••@example.org", recipientType: "cc",
        status: "no-action", actedAt: null, routingOrder: 3 },
    ]);
    expect(JSON.stringify(view)).not.toContain("juan@example.com");
  });

  it("keeps only timeline events, in the audit trail's own wording", () => {
    const view = presentVerificationDetails(PROJECTION);
    expect(view.events.map(e => e.type)).not.toContain("submission-accepted");
    expect(view.events[0]).toEqual({
      type: "transaction-sent", label: "Request sent for signing", at: T0 - 5000,
    });
    expect(view.events.at(-1)?.label).toBe("Signing request completed");
  });
});

describe("the code email", () => {
  it("renders the code, the expiry and the document title", () => {
    const templates = createTemplateRegistry(ALL_TEMPLATES);
    const rendered = templates.render(
      { key: "verification-access-code", version: 1 },
      { recipientName: "Maria Santos", documentTitle: "Office Lease" },
      { secret: "123456", buildLink: () => "", buildPath: () => "" },
    );
    expect(rendered.textBody).toContain(
      "Your LAGDA verification code is 123456. It expires in 10 minutes. "
      + "If you did not ask for it, ignore this email.");
    expect(rendered.textBody).toContain("Office Lease");
    expect(rendered.htmlBody).toContain("123456");
  });
});
