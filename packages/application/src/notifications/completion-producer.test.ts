// Turning a completed request into a notification: what the intent carries,
// what it must never carry, and what must not be able to fail a completion.
//
// The last of those is the reason several of these tests exist. This producer
// runs INSIDE the finalization transaction that seals a legal document, so any
// input it rejects is an input that permanently prevents a signed document
// from completing. A workspace-supplied document title is not allowed to have
// that power.

import { describe, it, expect } from "vitest";
import {
  createCompletionNotificationProducer,
} from "./completion-producer.js";
import { createTemplateRegistry } from "./template-registry.js";
import { ALL_TEMPLATES } from "./templates.js";
import { NOTIFICATION_POLICIES } from "./policy.js";
import type {
  NewNotificationIntent, NotificationIntentId, NotificationDeliveryId,
} from "../common/ports/notifications.js";
import type { SigningRequestId } from "../common/ports/signing-requests.js";
import type { WorkspaceId, UserId } from "@lagda/contracts";

const AT = 1_760_000_000_000;
const WORKSPACE = "ws_1" as WorkspaceId;
const REQUEST = "sreq_1" as SigningRequestId;
const SENDER = "usr_1" as UserId;

function harness(over: {
  senderName?: string | null;
  workspaceName?: string | null;
  documentTitle?: string;
  signerCount?: number;
  senderEmail?: string;
} = {}) {
  const created: NewNotificationIntent[] = [];
  const templates = createTemplateRegistry(ALL_TEMPLATES);

  const producer = createCompletionNotificationProducer({
    templates,
    ids: {
      nextNotificationIntentId: () => "nint_1" as NotificationIntentId,
      nextNotificationDeliveryId: () => "ndel_1" as NotificationDeliveryId,
    },
    clock: { now: () => AT },
  });

  const repositories = {
    notifications: {
      createIfAbsent: (intent: NewNotificationIntent) => {
        created.push(intent);
        return Promise.resolve({
          outcome: "created" as const, intent: intent as never,
        });
      },
    },
    workspaces: {
      find: () => Promise.resolve(
        over.workspaceName === null
          ? null
          : {
            workspaceId: WORKSPACE,
            name: over.workspaceName ?? "Reyes Legal",
            createdAt: AT,
          }),
    },
    actorProfiles: {
      displayNameOf: () => Promise.resolve(
        over.senderName === undefined ? "Paulo Reyes" : over.senderName),
    },
  } as never;

  return {
    created,
    templates,
    run: () => producer({
      signingRequestId: REQUEST,
      workspaceId: WORKSPACE,
      senderUserId: SENDER,
      senderEmail: over.senderEmail ?? "paulo@example.test",
      documentTitle: over.documentTitle ?? "Lease Agreement 2026",
      signerCount: over.signerCount ?? 2,
    }, repositories, null),
  };
}

describe("what the intent carries", () => {
  it("carries NO credential at all", async () => {
    // The distinguishing property of this notification. The reader is the
    // sender, who already holds an account and already has authorised access
    // to the document — there is nothing to hand them. A bearer token here
    // would be a credential minted for somebody who does not need one, with a
    // lifetime nothing tracks.
    const h = harness();

    await h.run();

    expect(h.created[0]?.secretRef).toBeUndefined();
    // Not merely absent from the field — absent from the whole row.
    expect(JSON.stringify(h.created[0])).not.toContain("secretRef");
  });

  it("carries no URL, so no hostname is baked into a durable row", async () => {
    // Same rule as the invitation producer (S147): the link is rebuilt from
    // configuration at send time. A URL frozen here would strand every unsent
    // message the day the canonical domain changed.
    const h = harness();

    await h.run();

    expect(JSON.stringify(h.created[0])).not.toContain("http");
  });

  it("identifies the sender as the audience, by id rather than address", async () => {
    // S21. `paulo@example.test` is a destination; the user id is an audience.
    // Keeping them apart is what lets the destination be frozen from the
    // authoritative identity while the audience stays a real foreign key.
    const h = harness();

    await h.run();

    expect(h.created[0]?.audience).toEqual({ kind: "USER", userId: SENDER });
    expect(h.created[0]?.destination).toBe("paulo@example.test");
  });

  it("keys the source on the REQUEST, which is what makes it dedupe", async () => {
    // Not the completion run. A run is an attempt, and Phase 1's retry path
    // may legitimately produce several for one request — keying on the run
    // would mean one email per attempt. The request is the granularity at
    // which `notification_intents_logical_key` becomes the guarantee.
    const h = harness();

    await h.run();

    expect(h.created[0]?.source).toEqual({
      kind: "SIGNING_REQUEST", sourceId: REQUEST,
    });
  });

  it("names a count of signers, never a roster", async () => {
    // A list of signer names and addresses would put the full participant
    // roster of a legal document into a JSONB column and then into an email
    // body. The sender can see the roster in the app, where access is checked.
    const h = harness({ signerCount: 3 });

    await h.run();

    expect(h.created[0]?.templateInput).toEqual({
      recipientName: "Paulo Reyes",
      documentTitle: "Lease Agreement 2026",
      workspaceName: "Reyes Legal",
      signerCount: 3,
    });
  });

  it("is workspace-scoped despite addressing a user", async () => {
    // The combination that makes this notification unusual, and it is
    // deliberate. A password reset is a fact about a PERSON and must not be
    // filed under a workspace (S46); a completed signing request is a fact
    // about the WORKSPACE's document, and filing it globally would orphan it
    // from the tenant whose data it describes.
    const h = harness();

    await h.run();

    expect(h.created[0]?.scope).toEqual({
      kind: "WORKSPACE", workspaceId: WORKSPACE,
    });
    expect(NOTIFICATION_POLICIES.SIGNING_COMPLETED.audienceKind).toBe("USER");
    expect(NOTIFICATION_POLICIES.SIGNING_COMPLETED.scopeKind).toBe("WORKSPACE");
  });

  it("freezes the template version rather than resolving it at send time", async () => {
    const h = harness();

    await h.run();

    expect(h.created[0]?.template).toEqual({
      key: "signing-completed",
      version: h.templates.currentVersion("signing-completed"),
    });
  });
});

describe("nothing here may fail a completion", () => {
  // Every test in this block describes an input that, if it threw, would roll
  // back the finalization transaction and fail the same way on every retry.

  it("truncates an over-long title instead of rejecting it", async () => {
    // The schema bounds the title at 300. A document title is
    // workspace-supplied content, so one character over that bound must not be
    // able to prevent its own document from completing.
    const title = "A".repeat(400);
    const h = harness({ documentTitle: title });

    await h.run();

    const input = h.created[0]?.templateInput as { documentTitle: string };
    expect(input.documentTitle).toHaveLength(300);
    expect(input.documentTitle.endsWith("…")).toBe(true);
    // And the row it produced is renderable, which is the property that
    // actually matters — a truncation that still failed validation would be
    // worthless.
    expect(() => h.templates.validateInput(
      { key: "signing-completed", version: 1 },
      h.created[0]?.templateInput as never,
    )).not.toThrow();
  });

  it("substitutes a fallback for an empty title", async () => {
    // `minLength: 1`, so an empty string is a validation failure rather than
    // an empty line in the body.
    const h = harness({ documentTitle: "   " });

    await h.run();

    expect((h.created[0]?.templateInput as { documentTitle: string })
      .documentTitle).toBe("Untitled document");
  });

  it("survives a deleted sender profile", async () => {
    const h = harness({ senderName: null });

    await h.run();

    expect((h.created[0]?.templateInput as { recipientName: string })
      .recipientName).toBe("there");
  });

  it("survives an unreadable workspace", async () => {
    const h = harness({ workspaceName: null });

    await h.run();

    expect((h.created[0]?.templateInput as { workspaceName: string })
      .workspaceName).toBe("your LAGDA workspace");
  });

  it("clamps an implausible signer count rather than rejecting it", async () => {
    const h = harness({ signerCount: 5000 });

    await h.run();

    expect((h.created[0]?.templateInput as { signerCount: number })
      .signerCount).toBe(1000);
  });

  it("produces NOTHING when no participant completed", async () => {
    // A completion with no certified participant is a data anomaly, not a
    // message. Skipping is the honest answer: clamping up to 1 would state a
    // falsehood in the body to satisfy a validator, and throwing would fail
    // the seal.
    for (const signerCount of [0, -1, 1.5, Number.NaN]) {
      const h = harness({ signerCount });

      await h.run();

      expect(h.created, `signerCount ${String(signerCount)}`).toHaveLength(0);
    }
  });
});

describe("the rendered message", () => {
  const render = (intent: NewNotificationIntent, templates: ReturnType<
    typeof createTemplateRegistry>) =>
    templates.render(intent.template, intent.templateInput, {
      secret: null,
      buildLink: () => {
        throw new Error("a completion notification must not build a token link");
      },
      buildPath: path => `https://app.lagda.test${path}`,
    });

  it("renders without a secret, and without asking for one", async () => {
    // The registry throws `MissingSecretError` for a secret-bearing template
    // rendered with none. This template declares `secretBearing: false`, and
    // `buildLink` above throws if it is reached — so a future edit that
    // introduced a token link would fail this test rather than ship a
    // credential to somebody who does not need one.
    const h = harness();
    await h.run();

    const message = render(h.created[0] as NewNotificationIntent, h.templates);

    expect(message.subject).toBe('"Lease Agreement 2026" is fully signed');
    expect(message.textBody).toContain("https://app.lagda.test/app/documents");
    expect(message.htmlBody).toContain("https://app.lagda.test/app/documents");
  });

  it("promises only what the product actually does", async () => {
    // The sealed document IS viewable — the documents list renders real
    // artifact content — so pointing there is truthful. What this must not do
    // is claim an attachment it does not carry or a direct download route that
    // does not exist.
    const h = harness();
    await h.run();

    const message = render(h.created[0] as NewNotificationIntent, h.templates);
    const body = `${message.subject}\n${message.textBody}`;

    expect(body.toLowerCase()).not.toContain("attach");
    expect(body.toLowerCase()).not.toContain("download");
    // And it says why the reader received it, which a completion notice to a
    // person who did not sign anything otherwise reads as unexplained.
    expect(message.textBody).toContain("you sent this document for signature");
  });

  it("agrees with the signer count in singular and plural", async () => {
    const one = harness({ signerCount: 1 });
    await one.run();
    expect(render(one.created[0] as NewNotificationIntent, one.templates)
      .textBody).toContain("completed by 1 signer");

    const many = harness({ signerCount: 4 });
    await many.run();
    expect(render(many.created[0] as NewNotificationIntent, many.templates)
      .textBody).toContain("completed by 4 signers");
  });

  it("escapes the title in the HTML part but not the text part", async () => {
    const h = harness({ documentTitle: 'Lease <b>"A"</b> & Co' });
    await h.run();

    const message = render(h.created[0] as NewNotificationIntent, h.templates);

    expect(message.textBody).toContain('Lease <b>"A"</b> & Co');
    expect(message.htmlBody).toContain("&lt;b&gt;");
    expect(message.htmlBody).not.toContain("<b>");
  });
});
