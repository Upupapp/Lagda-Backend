// Final copies (073): who is sent one, the sender's switch, and every way a
// download link is refused.

import { describe, it, expect, beforeEach } from "vitest";
import type { WorkspaceId, UserId, DocumentId } from "@lagda/contracts";
import type {
  SigningRequestId, ArtifactId, PreparationId, SigningRequestRecipientId,
  SealedDeliverySecret, SigningRequestRecord,
} from "../common/ports/index.js";
import type { RecipientType } from "@lagda/contracts";
import {
  FixedClock, FakeTransactionManager, InMemoryStore, fakeTemplateRegistry,
} from "../test-support/fakes.js";
import {
  produceFinalCopies, downloadFinalCopy, FinalCopyLinkInvalidError,
  FINAL_COPY_LIFETIME_MS, type FinalCopyProducerDependencies,
} from "./final-copies.js";

const WS = "ws_1" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const AT = 1_760_000_000_000;
const SEALED_ART = "art_sealed" as ArtifactId;

class Tokens {
  private next = 1;
  readonly issued: string[] = [];
  issue() {
    const serial = this.next++;
    const raw = `tok${String(serial).padStart(40, "x")}`;
    this.issued.push(raw);
    return { raw, digest: String(serial).padStart(64, "a") as never };
  }
  digest(submitted: string) {
    const index = this.issued.indexOf(submitted);
    return index === -1 ? null : String(index + 1).padStart(64, "a") as never;
  }
}

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let tokens: Tokens;
let deps: FinalCopyProducerDependencies;

function request(over: Partial<SigningRequestRecord> = {}): SigningRequestRecord {
  return {
    signingRequestId: REQUEST, workspaceId: WS, documentId: "doc_1" as DocumentId,
    sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: "completed", completionReadyAt: AT, completedAt: AT, expiresAt: null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT, ...over,
  };
}

function participant(id: string, type: RecipientType, email: string): void {
  store.signingRequestRecipients.push({
    recipientId: id as SigningRequestRecipientId, sourcePreparationRecipientId: null,
    name: id, email, normalizedEmail: email, organization: null,
    type, isRequired: type !== "viewer" && type !== "carbon-copy",
    orderIndex: store.signingRequestRecipients.length, routingOrder: 1,
  });
  store.snapshotOwners.set(id, REQUEST);
}

beforeEach(() => {
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  tokens = new Tokens();
  let n = 0;
  deps = {
    tokens,
    sealer: { keyVersion: "v1", seal: (raw: string) => `sealed:${raw}` as SealedDeliverySecret },
    ids: {
      nextFinalCopyGrantId: () => `fcg_${String(++n)}` as never,
      nextNotificationIntentId: () => `ni_${String(++n)}` as never,
      nextNotificationDeliveryId: () => `nd_${String(++n)}` as never,
    },
    templates: fakeTemplateRegistry,
    clock: new FixedClock(AT),
  };
  store.signingRequests.push(request());
  participant("rr_signer", "signer", "signer@x.com");
  participant("rr_approver", "approver", "approver@x.com");
  participant("rr_viewer", "viewer", "viewer@x.com");
  participant("rr_cc", "carbon-copy", "cc@x.com");
});

const produce = (r: SigningRequestRecord = request()) =>
  transactions.runForWorkspace(WS, uow => produceFinalCopies(r, AT, uow, deps));
const destinations = () =>
  [...store.notificationDeliveries.values()].map(d => d.destination).sort();

describe("producing final copies", () => {
  it("sends every participant and copy recipient a copy — never a viewer", async () => {
    expect(await produce()).toBe(3);
    expect(destinations()).toEqual(["approver@x.com", "cc@x.com", "signer@x.com"]);
    expect(store.finalCopyGrants).toHaveLength(3);
    expect(store.finalCopyGrants.every(g => g.expiresAt === AT + FINAL_COPY_LIFETIME_MS)).toBe(true);
  });

  it("sends nothing when the sender switched it off for this document", async () => {
    expect(await produce(request({ shareFinalCopy: false }))).toBe(0);
    expect(store.finalCopyGrants).toHaveLength(0);
    expect(destinations()).toEqual([]);
  });

  it("stores only the digest, never the raw link", async () => {
    await produce();
    const stored = JSON.stringify(store.finalCopyGrants);
    for (const raw of tokens.issued) expect(stored).not.toContain(raw);
  });

  it("a re-driven completion queues no second copy", async () => {
    await produce();
    expect(await produce()).toBe(0);
    expect(store.finalCopyGrants).toHaveLength(3);
  });
});

describe("downloading a final copy", () => {
  const storage = {
    getObject: () => Promise.resolve({
      ref: { zone: "artifacts", key: "k" }, sizeBytes: 3, mediaType: "application/pdf",
      // eslint-disable-next-line @typescript-eslint/require-await
      stream: (async function* () { yield new Uint8Array([1, 2, 3]); })(),
    }),
  };
  const download = (raw: string, now = AT) => downloadFinalCopy(raw, {
    transactions, tokens, storage: storage as never, clock: new FixedClock(now),
  });

  beforeEach(async () => {
    store.seals.push({ workspaceId: WS, signingRequestId: REQUEST, sealedArtifactId: SEALED_ART } as never);
    store.artifacts.push({
      artifactId: SEALED_ART, workspaceId: WS, documentId: "doc_1" as DocumentId,
      artifactType: "sealed", storageReference: "ws/doc/sealed" as never,
      mediaType: "application/pdf", sizeBytes: 3, digestAlgorithm: "sha-256",
      digest: "c".repeat(64) as never, pageCount: 1, rotatedPageCount: 0, createdAt: AT,
    } as never);
    await produce();
  });

  it("returns the sealed PDF for a valid link", async () => {
    const got = await download(tokens.issued[0]!);
    expect(got.mediaType).toBe("application/pdf");
    expect(got.documentTitle).toBe("Office Lease");
  });

  it("refuses an unknown link", async () => {
    await expect(download("tok" + "z".repeat(40))).rejects.toBeInstanceOf(FinalCopyLinkInvalidError);
  });

  it("refuses an expired link", async () => {
    await expect(download(tokens.issued[0]!, AT + FINAL_COPY_LIFETIME_MS))
      .rejects.toBeInstanceOf(FinalCopyLinkInvalidError);
  });

  it("refuses a revoked link", async () => {
    store.finalCopyGrants[0]!.revokedAt = AT;
    await expect(download(tokens.issued[0]!)).rejects.toBeInstanceOf(FinalCopyLinkInvalidError);
  });
});
