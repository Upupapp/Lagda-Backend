// Binding an account to a recipient.
//
// This is the one place the two credential realms meet, so the assertions are
// about what must NOT be possible: binding with an address you have not
// proved, binding to someone else's recipient, reusing a code, and learning
// from an error which of those you got wrong.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mintSigningLinkIntent, claimSigningLink, SigningLinkNotClaimableError,
} from "./signing-account-link.js";
import type {
  SigningAccountLinkRepository, SigningLinkIntentRecord,
} from "../common/ports/signing-account-link.js";

const NOW = 1_700_000_000_000;
const clock = { now: () => NOW };

/**
 * The digest domain, stood in for.
 *
 * Deliberately not sha256 here: the test asserts that what is STORED is not
 * the code, and a fake that transforms at all proves that as well as the real
 * one would — while making it obvious the application layer does no hashing.
 */
const codes = { digestHandoffCode: (code: string) => `digest(${code})` };
const PASSWORD = "correct horse battery staple";

/** The step-up and the handoff, both satisfied. */
const handedOver: unknown[] = [];
function stepUp(options: { passwordOk?: boolean; saved?: number } = {}) {
  return {
    verifyPassword: (_id: string, password: string) =>
      Promise.resolve(options.passwordOk !== false && password === PASSWORD),
    handOverSavedSignatures: (input: unknown) => {
      handedOver.push(input);
      return Promise.resolve(options.saved ?? 1);
    },
  };
}

/** An in-memory stand-in that honours the conditional-claim semantics. */
function repository() {
  const intents = new Map<string, {
    record: SigningLinkIntentRecord; consumed: boolean;
  }>();
  const links: unknown[] = [];

  const repo: SigningAccountLinkRepository = {
    createIntent: (input) => {
      intents.set(input.intentDigest, {
        record: {
          workspaceId: input.workspaceId,
          signingRequestId: input.signingRequestId,
          recipientId: input.recipientId,
          recipientNormalizedEmail: input.recipientNormalizedEmail,
          recipientSessionId: input.recipientSessionId,
          expiresAt: input.expiresAt,
          consumedAt: null,
        },
        consumed: false,
      });
      return Promise.resolve();
    },
    claimIntent: (intentDigest, now) => {
      const entry = intents.get(intentDigest);
      // Exactly the conditions the SQL UPDATE carries.
      if (entry === undefined) return Promise.resolve(null);
      if (entry.consumed) return Promise.resolve(null);
      if (entry.record.expiresAt <= now) return Promise.resolve(null);
      entry.consumed = true;
      return Promise.resolve(entry.record);
    },
    createLink: (input) => { links.push(input); return Promise.resolve(); },
    findLinkForRecipient: () => Promise.resolve(null),
  };
  return { repo, links, intents };
}

const RECIPIENT = {
  workspaceId: "ws_1",
  signingRequestId: "sr_1",
  recipientId: "rcp_1",
  recipientNormalizedEmail: "signer@example.com",
  recipientSessionId: "rses_1",
};

function accounts(identity: {
  normalizedEmail: string; emailVerifiedAt: Date | null;
} | null) {
  return { findIdentity: () => Promise.resolve(identity) };
}

let ids: () => string;
beforeEach(() => { ids = vi.fn(() => "lnk_1"); });

describe("minting", () => {
  it("returns a code and stores only its digest", async () => {
    const { repo, intents } = repository();

    const minted = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    expect(minted.code).toMatch(/^[A-Za-z0-9_-]+$/);
    // A stolen backup must not yield usable codes.
    expect([...intents.keys()][0]).not.toBe(minted.code);
    expect([...intents.keys()][0]).toBe(`digest(${minted.code})`);
  });

  it("expires it quickly", async () => {
    const { repo } = repository();
    const minted = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
    expect(minted.expiresAt - NOW).toBeLessThanOrEqual(120_000);
    expect(minted.expiresAt).toBeGreaterThan(NOW);
  });

  it("mints a different code every time", async () => {
    const { repo } = repository();
    const a = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
    const b = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
    expect(a.code).not.toBe(b.code);
  });
});

describe("claiming", () => {
  it("binds when a VERIFIED address matches", async () => {
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    const result: { signingRequestId: string; recipientId: string; preparedCount: number } = await claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    });

    expect(result).toMatchObject({ signingRequestId: "sr_1", recipientId: "rcp_1" });
    expect(links).toHaveLength(1);
  });

  it("refuses an address that has never been verified", async () => {
    // users.email_verified_at is nullable. Without this, someone registers
    // with a victim's address, never verifies it, and later satisfies the
    // comparison with a forwarded link.
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: null,
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);

    expect(links).toHaveLength(0);
  });

  it("refuses a different account, however verified", async () => {
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_2", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "someone.else@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);

    expect(links).toHaveLength(0);
  });

  it("refuses an unknown code", async () => {
    const { repo } = repository();
    await expect(claimSigningLink("usr_1", "never-minted", PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);
  });

  it("refuses a code already used", async () => {
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
    const deps = {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    };

    await claimSigningLink("usr_1", code, PASSWORD, deps);

    await expect(claimSigningLink("usr_1", code, PASSWORD, deps))
      .rejects.toBeInstanceOf(SigningLinkNotClaimableError);
  });

  it("refuses an expired code", async () => {
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_1", code, PASSWORD, {
      clock: { now: () => NOW + 200_000 },
      codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);
  });

  it("burns a code that failed the comparison", async () => {
    // A wrong guess must not return the code to the pool, or a stolen code
    // could be tried against account after account until one matched.
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_2", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "someone.else@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toThrow();

    // Even the rightful owner cannot use it now.
    await expect(claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);
  });

  it("says the same thing however it failed", async () => {
    // Unknown, expired, claimed, wrong account, unverified — one message.
    // "Wrong account" in particular would otherwise confirm that some other
    // account owns that address.
    const { repo } = repository();
    const messages = new Set<string>();

    for (const scenario of [
      { user: "usr_1", code: "unknown", identity: { normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW) } },
      { user: "usr_2", code: null, identity: { normalizedEmail: "other@example.com", emailVerifiedAt: new Date(NOW) } },
      { user: "usr_1", code: null, identity: { normalizedEmail: "signer@example.com", emailVerifiedAt: null } },
      { user: "usr_1", code: null, identity: null },
    ]) {
      const minted = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
      try {
        await claimSigningLink(scenario.user, scenario.code ?? minted.code, PASSWORD, {
          clock, codes, links: repo, ids, ...stepUp(), accounts: accounts(scenario.identity),
        });
      } catch (error) {
        messages.add((error as Error).message);
      }
    }

    expect(messages.size).toBe(1);
  });

  it("records the address the binding was justified by", async () => {
    // If the account later changes its address, the audit still says which
    // one was compared.
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    });

    expect(links[0]).toMatchObject({
      userId: "usr_1",
      matchedNormalizedEmail: "signer@example.com",
      signingRequestId: "sr_1",
      recipientId: "rcp_1",
      workspaceId: "ws_1",
    });
  });
});

describe("the port offers no way to build an inbox", () => {
  it("has no lookup by user", () => {
    // Migration 051's rule, asserted rather than remembered: a query by user
    // is the query an inbox needs, and this table must not become the thing
    // an inbox is built on.
    const { repo } = repository();
    expect(Object.keys(repo).sort()).toEqual(
      ["claimIntent", "createIntent", "createLink", "findLinkForRecipient"],
    );
  });
});


describe("the step-up", () => {
  it("refuses a wrong password even when everything else matches", async () => {
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_1", code, "wrong", {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toBeInstanceOf(SigningLinkNotClaimableError);

    expect(links).toHaveLength(0);
  });

  it("BURNS the code on a wrong password", async () => {
    // The ordering that makes each code exactly one attempt. If a wrong
    // password left it usable, a stolen code could be retried against one
    // account after another until a guess landed.
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });
    const good = {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    };

    await expect(claimSigningLink("usr_1", code, "wrong", good)).rejects.toThrow();

    // Even with the right password now, the code is spent.
    await expect(claimSigningLink("usr_1", code, PASSWORD, good))
      .rejects.toBeInstanceOf(SigningLinkNotClaimableError);
  });

  it("hands nothing over when the password fails", async () => {
    const before = handedOver.length;
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await expect(claimSigningLink("usr_1", code, "wrong", {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    })).rejects.toThrow();

    expect(handedOver.length).toBe(before);
  });
});

describe("the handoff", () => {
  it("binds an account that has nothing saved", async () => {
    // An ordinary outcome, not a failure. They get "Signed in as ..." and
    // simply have nothing to apply.
    const { repo, links } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    const result = await claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp({ saved: 0 }),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    });

    expect(result.preparedCount).toBe(0);
    expect(links).toHaveLength(1);
  });

  it("hands over scoped to THIS recipient of THIS request", async () => {
    const before = handedOver.length;
    const { repo } = repository();
    const { code } = await mintSigningLinkIntent(RECIPIENT, { clock, codes, links: repo, ids });

    await claimSigningLink("usr_1", code, PASSWORD, {
      clock, codes, links: repo, ids, ...stepUp(),
      accounts: accounts({
        normalizedEmail: "signer@example.com", emailVerifiedAt: new Date(NOW),
      }),
    });

    expect(handedOver[before]).toEqual({
      userId: "usr_1",
      signingRequestId: "sr_1",
      recipientId: "rcp_1",
      // Bound to the session that asked. A signing link can be forwarded;
      // without this, whoever held a forwarded link after a claim would
      // inherit the mark and the right to apply it.
      recipientSessionId: "rses_1",
      at: new Date(NOW),
    });
  });
});
