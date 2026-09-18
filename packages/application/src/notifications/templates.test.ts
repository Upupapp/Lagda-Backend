// Template rendering: the freeze, the escaping, and the secret.
//
// These are the tests that stop a deploy from rewriting mail that was already
// promised, and stop a recipient's own name from becoming markup in it.

import { describe, it, expect } from "vitest";
import {
  createTemplateRegistry, TemplateNotFoundError, TemplateInputError,
  MissingSecretError,
  type AnyNotificationTemplate, type RenderContext,
} from "./template-registry.js";
import { ALL_TEMPLATES, signingInvitationV1 } from "./templates.js";
import { NotificationRenderError } from "./rendering.js";
import type { NotificationTemplateInput } from "../common/ports/notifications.js";

const context = (secret: string | null = "raw-secret-value"): RenderContext => ({
  secret,
  buildLink: (path, token) => `https://app.lagda.test${path}?token=${token}`,
  // Token-free variant. `signing-completed` is the one template that uses it:
  // its reader is the sender, who already has an account, so there is no
  // credential to hand over.
  buildPath: path => `https://app.lagda.test${path}`,
});

const signingInput = {
  recipientName: "Maria Santos",
  documentTitle: "Lease Agreement",
  senderDisplayName: "Paulo Reyes",
  workspaceName: "Reyes Legal",
} satisfies NotificationTemplateInput;

const registry = createTemplateRegistry(ALL_TEMPLATES);

describe("template registry", () => {
  it("registers every template the product sends", () => {
    for (const template of ALL_TEMPLATES) {
      expect(registry.has({ key: template.key, version: template.version })).toBe(true);
    }
  });

  it("refuses an unregistered version rather than falling back to the newest", () => {
    // S243. The failure mode this prevents: a v1 intent queued before a deploy
    // renders with v2 semantics because lookup was lenient.
    expect(() => registry.get({ key: "signing-invitation", version: 99 }))
      .toThrow(TemplateNotFoundError);
  });

  it("keeps an old version renderable after a newer one is registered", () => {
    // S74, S242. Two versions coexist; the old ref still resolves to the old
    // copy, not the new one.
    const v2: AnyNotificationTemplate = {
      ...signingInvitationV1,
      version: 2,
      render: () => ({ subject: "v2 subject", textBody: "v2 body" }),
    };
    const widened = createTemplateRegistry([...ALL_TEMPLATES, v2]);

    const rendered = widened.render(
      { key: "signing-invitation", version: 1 },
      signingInput,
      context(),
    );

    expect(rendered.subject).not.toBe("v2 subject");
    expect(rendered.subject).toContain("Lease Agreement");
    expect(widened.currentVersion("signing-invitation")).toBe(2);
  });

  it("rejects a duplicate registration of one version", () => {
    expect(() => createTemplateRegistry([signingInvitationV1, signingInvitationV1]))
      .toThrow(/Duplicate template registration/u);
  });
});

describe("template input", () => {
  it("rejects an unknown variable", () => {
    // S244. `additionalProperties: false` is what makes a typo a failure at
    // creation rather than a blank in a delivered message.
    expect(() =>
      registry.validateInput({ key: "signing-invitation", version: 1 }, {
        ...signingInput,
        unexpected: "value",
      }),
    ).toThrow(TemplateInputError);
  });

  it("rejects a missing variable", () => {
    const { documentTitle: _omitted, ...incomplete } = signingInput;
    expect(() =>
      registry.validateInput({ key: "signing-invitation", version: 1 }, incomplete),
    ).toThrow(TemplateInputError);
  });

  it("validates again at render time, not only at creation", () => {
    // The row may have been written by a previous deployment.
    expect(() =>
      registry.render({ key: "signing-invitation", version: 1 }, { wrong: 1 }, context()),
    ).toThrow(TemplateInputError);
  });
});

describe("escaping and injection", () => {
  it("escapes HTML in a recipient's own name", () => {
    // S245. A signer may legitimately be named with characters that are markup.
    const rendered = registry.render(
      { key: "signing-invitation", version: 1 },
      { ...signingInput, recipientName: "<script>alert(1)</script>" },
      context(),
    );

    expect(rendered.htmlBody).not.toContain("<script>");
    expect(rendered.htmlBody).toContain("&lt;script&gt;");
    // The text part is NOT escaped: escaping there would show `&lt;` to a human.
    expect(rendered.textBody).toContain("<script>");
  });

  it("escapes quotes, so an attribute cannot be broken out of", () => {
    const rendered = registry.render(
      { key: "signing-invitation", version: 1 },
      { ...signingInput, documentTitle: `" onmouseover="steal()` },
      context(),
    );

    expect(rendered.htmlBody).not.toContain('onmouseover="steal()"');
    expect(rendered.htmlBody).toContain("&quot;");
  });

  it("does not double-escape an ampersand", () => {
    const rendered = registry.render(
      { key: "signing-invitation", version: 1 },
      { ...signingInput, workspaceName: "Reyes & Santos" },
      context(),
    );

    expect(rendered.htmlBody).toContain("Reyes &amp; Santos");
    expect(rendered.htmlBody).not.toContain("&amp;amp;");
  });

  it("rejects a subject carrying CRLF", () => {
    // S72, S246. The header-injection case: a title containing a newline would
    // otherwise become a second header in a naive transport.
    expect(() =>
      registry.render(
        { key: "signing-invitation", version: 1 },
        { ...signingInput, documentTitle: "Lease\r\nBcc: attacker@example.test" },
        context(),
      ),
    ).toThrow(NotificationRenderError);
  });

  it("rejects a subject carrying a bidirectional override", () => {
    expect(() =>
      registry.render(
        { key: "signing-invitation", version: 1 },
        { ...signingInput, documentTitle: "Lease‮txt.exe" },
        context(),
      ),
    ).toThrow(NotificationRenderError);
  });

  it("bounds every interpolated variable through its schema", () => {
    // The schema is the single authority on variable length -- checked at
    // creation AND again at render, so a row written by an older deployment
    // cannot smuggle an unbounded value into a body.
    expect(() =>
      registry.render(
        { key: "signing-invitation", version: 1 },
        { ...signingInput, recipientName: "a".repeat(201) },
        context(),
      ),
    ).toThrow(TemplateInputError);
  });
});

describe("secrets", () => {
  it("refuses to render a secret-bearing template without a secret", () => {
    // S207. Rendering a signing invitation with no link would deliver a message
    // the recipient cannot act on, and would look like a successful send.
    expect(() =>
      registry.render({ key: "signing-invitation", version: 1 }, signingInput, context(null)),
    ).toThrow(MissingSecretError);
  });

  it("builds links from configured base only, never an inbound host", () => {
    // S147. The raw token appears in the URL the recipient receives; the HOST
    // comes from configuration, so a spoofed Host header cannot redirect it.
    const rendered = registry.render(
      { key: "signing-invitation", version: 1 },
      signingInput,
      context(),
    );

    expect(rendered.textBody).toContain("https://app.lagda.test/sign?token=raw-secret-value");
  });

  it("never places a secret in a template's persisted input", () => {
    // S253. The frozen model holds display data only; the credential arrives
    // as a render-time argument and is gone when the call returns.
    for (const template of ALL_TEMPLATES) {
      const properties = Object.keys(
        (template.schema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) {
        expect(property).not.toMatch(/token|secret|otp|code|credential|password/iu);
      }
    }
  });
});
