// Continuing to sign from the app: the second verification.
//
// The claims that carry weight:
//   nothing is written unless the entry is the caller's own, open one;
//   the password is re-proved, and a wrong one writes nothing;
//   the account's address must be VERIFIED and must still match;
//   a recipient bound to a different account is refused, not overwritten;
//   the saved marks go to the one session the code will open;
//   the code is returned, never stored -- only its digest is.

import { describe, it, expect } from "vitest";
import {
  beginInAppSigning, InAppSigningPasswordError, InAppSigningUnavailableError,
  InAppSigningUnverifiedError, type BeginInAppSigningDependencies,
} from "./in-app-signing.js";
import { SigningLinkAddressedElsewhereError } from "./signing-account-link.js";
import type { UserSigningInboxRecord, SigningResumeIntentRecord } from "../common/ports/user-signing-records.js";
import type { SigningAccountLinkRecord } from "../common/ports/signing-account-link.js";

const NOW = Date.parse("2026-09-22T08:00:00.000Z");
const USER = "usr_signer";

const ENTRY: UserSigningInboxRecord = {
  userId: USER, signingRequestId: "sr_1", recipientId: "srr_1", workspaceId: "ws_sender",
  recipientNormalizedEmail: "signer@example.com", grantCredentialDigest: "a".repeat(64),
  documentTitle: "Employment Agreement", senderName: "Paul", senderEmail: "paul@example.com",
  workspaceName: "Acme", invitedAt: NOW - 1000, expiresAt: NOW + 86_400_000,
  closedAt: null, closedReason: null,
};

function harness(over: Partial<BeginInAppSigningDependencies> = {}, existingLink: SigningAccountLinkRecord | null = null) {
  const created: SigningAccountLinkRecord[] = [];
  const intents: SigningResumeIntentRecord[] = [];
  const handed: { recipientSessionId: string }[] = [];
  const deps: BeginInAppSigningDependencies = {
    clock: { now: () => NOW },
    codes: { digestHandoffCode: code => `digest(${code})` },
    findOpenEntry: (userId, request, recipient) => Promise.resolve(
      userId === USER && request === "sr_1" && recipient === "srr_1" ? ENTRY : null),
    verifyPassword: (_id, password) => Promise.resolve(password === "correct horse"),
    findIdentity: () => Promise.resolve({ normalizedEmail: "signer@example.com", emailVerified: true }),
    links: {
      findLinkForRecipient: () => Promise.resolve(existingLink),
      createLink: link => { created.push(link); return Promise.resolve(); },
    },
    handOverSavedSignatures: input => { handed.push(input); return Promise.resolve(1); },
    resumeIntents: {
      create: intent => { intents.push(intent); return Promise.resolve(); },
      consume: () => Promise.resolve(null),
    },
    newSessionId: () => "rss_preset",
    newLinkId: () => "sal_new",
    ...over,
  };
  return { deps, created, intents, handed };
}

const input = (password = "correct horse") =>
  ({ signingRequestId: "sr_1", recipientId: "srr_1", password });

describe("beginInAppSigning", () => {
  it("mints a code bound to the entry's grant and a preset session", async () => {
    const h = harness();
    const begun = await beginInAppSigning(USER, input(), h.deps);

    expect(begun.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(begun.expiresAt).toBe(NOW + 120_000);
    const [intent] = h.intents;
    // Only the DIGEST is stored, never the code.
    expect(intent?.intentDigest).toBe(`digest(${begun.code})`);
    expect(JSON.stringify(h.intents)).not.toContain(`"${begun.code}"`);
    expect(intent?.grantCredentialDigest).toBe(ENTRY.grantCredentialDigest);
    // The marks go to exactly the session the code opens.
    expect(intent?.signingSessionId).toBe("rss_preset");
    expect(h.handed[0]?.recipientSessionId).toBe("rss_preset");
    // And the recipient is bound, so the ceremony runs as this account.
    expect(h.created).toHaveLength(1);
  });

  it("refuses an entry that is not the caller's own, writing nothing", async () => {
    const h = harness();
    await expect(beginInAppSigning("usr_someone_else", input(), h.deps))
      .rejects.toBeInstanceOf(InAppSigningUnavailableError);
    expect(h.intents).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it("refuses a wrong password, writing nothing", async () => {
    const h = harness();
    await expect(beginInAppSigning(USER, input("wrong"), h.deps))
      .rejects.toBeInstanceOf(InAppSigningPasswordError);
    expect(h.intents).toHaveLength(0);
    expect(h.handed).toHaveLength(0);
  });

  it("refuses an unverified address", async () => {
    const h = harness({
      findIdentity: () => Promise.resolve({ normalizedEmail: "signer@example.com", emailVerified: false }),
    });
    await expect(beginInAppSigning(USER, input(), h.deps))
      .rejects.toBeInstanceOf(InAppSigningUnverifiedError);
    expect(h.intents).toHaveLength(0);
  });

  it("refuses an account whose address has changed since the invitation", async () => {
    const h = harness({
      findIdentity: () => Promise.resolve({ normalizedEmail: "new@example.com", emailVerified: true }),
    });
    await expect(beginInAppSigning(USER, input(), h.deps))
      .rejects.toBeInstanceOf(SigningLinkAddressedElsewhereError);
    expect(h.intents).toHaveLength(0);
  });

  it("refuses a recipient already bound to a different account", async () => {
    const h = harness({}, {
      signingAccountLinkId: "sal_other", userId: "usr_other", workspaceId: "ws_sender",
      signingRequestId: "sr_1", recipientId: "srr_1",
      matchedNormalizedEmail: "signer@example.com", linkedAt: new Date(NOW),
    } as SigningAccountLinkRecord);
    await expect(beginInAppSigning(USER, input(), h.deps))
      .rejects.toBeInstanceOf(InAppSigningUnavailableError);
    expect(h.intents).toHaveLength(0);
  });

  it("does not bind twice when the recipient is already this account's", async () => {
    const h = harness({}, {
      signingAccountLinkId: "sal_mine", userId: USER, workspaceId: "ws_sender",
      signingRequestId: "sr_1", recipientId: "srr_1",
      matchedNormalizedEmail: "signer@example.com", linkedAt: new Date(NOW),
    } as SigningAccountLinkRecord);
    await beginInAppSigning(USER, input(), h.deps);
    expect(h.created).toHaveLength(0);
    expect(h.intents).toHaveLength(1);
  });
});
