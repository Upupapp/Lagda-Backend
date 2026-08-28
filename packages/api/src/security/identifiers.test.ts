// What a production identifier has to be, and what production must never mint.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  createWorkspaceIdGenerator, createWorkspaceMemberIdGenerator,
  createContactIdGenerator, createDocumentIdGenerator,
  createPreparationIdGenerator, createRecipientIdGenerator,
  createSigningRequestIdGenerator, createSigningAccessIdGenerator,
  createEvidenceEventIdGenerator, createArtifactIdGenerator,
  createSealIdGenerator, createNotificationIntentIdGenerator,
  createNotificationDeliveryIdGenerator,
  createRecipientSigningSessionIdGenerator, createSigningWorkflowIdGenerator,
  createWorkspaceInvitationIdGenerator, createOrganizationUnitIdGenerator,
} from "./identifiers.js";

/** Every mint on every generator, as `[expected prefix, produce]` pairs. */
const MINTS: ReadonlyArray<readonly [string, () => string]> = (() => {
  const preparation = createPreparationIdGenerator();
  const signingRequest = createSigningRequestIdGenerator();
  return [
    ["ws", () => createWorkspaceIdGenerator().nextWorkspaceId()],
    ["mem", () => createWorkspaceMemberIdGenerator().nextWorkspaceMemberId()],
    ["con", () => createContactIdGenerator().nextContactId()],
    ["doc", () => createDocumentIdGenerator().nextDocumentId()],
    ["prep", () => preparation.nextPreparationId()],
    ["pf", () => preparation.nextPreparationFieldId()],
    ["rcp", () => createRecipientIdGenerator().nextRecipientId()],
    ["sr", () => signingRequest.nextSigningRequestId()],
    ["srr", () => signingRequest.nextSigningRequestRecipientId()],
    ["srf", () => signingRequest.nextSigningRequestFieldId()],
    ["sag", () => createSigningAccessIdGenerator().nextSigningAccessGrantId()],
    ["ev", () => createEvidenceEventIdGenerator().nextEvidenceEventId()],
    ["art", () => createArtifactIdGenerator().nextArtifactId()],
    ["seal", () => createSealIdGenerator().nextSealId()],
    ["nint", () => createNotificationIntentIdGenerator().nextNotificationIntentId()],
    ["ndel", () => createNotificationDeliveryIdGenerator().nextNotificationDeliveryId()],
    ["rss", () =>
      createRecipientSigningSessionIdGenerator().nextRecipientSigningSessionId()],
    ["swi", () => createSigningWorkflowIdGenerator().nextSigningWorkflowIntentId()],
    ["inv", () =>
      createWorkspaceInvitationIdGenerator().nextWorkspaceInvitationId()],
    ["unit", () =>
      createOrganizationUnitIdGenerator().nextOrganizationUnitId()],
  ];
})();

describe("production identifiers", () => {
  it.each(MINTS)("%s ids are prefixed, hex, and fit varchar(64)", (prefix, produce) => {
    const id = produce();
    expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
    // Every id column in the schema is `varchar(64)`. An id that overflowed it
    // would not be caught until an insert failed in production.
    expect(id.length).toBeLessThanOrEqual(64);
  });

  /**
   * The property the `Sequential*` fakes do not have.
   *
   * A fresh generator per draw, deliberately: it is the case that breaks a
   * counter, because a counter's uniqueness lives in an instance and
   * production has one instance per process, per deploy, per replica.
   */
  it.each(MINTS)("%s ids do not repeat across fresh generators", (_prefix, produce) => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) seen.add(produce());
    expect(seen.size).toBe(2_000);
  });

  it("mints a different id for every type from one draw", () => {
    const ids = MINTS.map(([, produce]) => produce());
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * ── The gate ───────────────────────────────────────────────────────────────
   *
   * The defect this module exists to fix was never a missing file. It was that
   * the ONLY implementation of these ports lived in `test-support`, so any
   * composition that needed an id had exactly one thing to reach for — and
   * reaching for it would have shipped `doc_1` to production.
   *
   * Asserting on the source text rather than on behaviour is the point: a
   * runtime assertion cannot tell a real generator from a fake one that happens
   * to be seeded high, and by the time it could, the ids are already in the
   * database.
   */
  it("the production entry point imports no test double", () => {
    const source = readFileSync(
      new URL("../server/start-server.ts", import.meta.url), "utf8",
    );
    // Comments are stripped before matching. That file now EXPLAINS why it uses
    // none of these, and a gate that a correct explanation trips is a gate
    // people delete. Stripping keeps all four assertions at full strength
    // rather than softening them to accommodate prose.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/test-support/);
    expect(code).not.toMatch(/Sequential[A-Za-z]*Ids/);
    expect(code).not.toMatch(/Fake[A-Za-z]*/);
    expect(code).not.toMatch(/InMemory[A-Za-z]*/);
  });
});
