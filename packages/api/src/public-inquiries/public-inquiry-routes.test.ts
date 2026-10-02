// POST /public/inquiries (095): the one write a visitor with no account can
// make. What protects it is the shape of the body and the limiter, so those
// are what this checks, through the real application.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AbuseLimiter, PublicInquiryDependencies, PublicInquiryRecord, PublicInquiryRepository,
} from "@lagda/application";
import { createTemplateRegistry, ALL_TEMPLATES } from "@lagda/application";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";

const AT = Date.parse("2026-10-02T09:00:00.000Z");

let stored: PublicInquiryRecord[] = [];
const transact = vi.fn();

const inquiries: PublicInquiryRepository = {
  insert: inquiry => { stored.push(inquiry); return Promise.resolve(); },
  find: id => Promise.resolve(stored.find(i => i.inquiryId === id) ?? null),
  list: () => Promise.resolve(stored),
  countByKind: () => Promise.resolve({ demo: 0, contact: 0, waitlist: 0 }),
  account: () => Promise.resolve(null),
  // No inbox account in this app: the message is stored and nobody is told.
  accountByNormalizedEmail: () => Promise.resolve(null),
  transact,
};

const dependencies = (): PublicInquiryDependencies => ({
  clock: { now: () => AT },
  inquiries,
  ids: { nextPublicInquiryId: () => `pin_${String(stored.length + 1)}` },
  templates: createTemplateRegistry(ALL_TEMPLATES),
  notificationIds: {
    nextNotificationIntentId: () => "nint_1" as never,
    nextNotificationDeliveryId: () => "ndel_1" as never,
  },
  inboxEmail: null,
});

async function buildApp(limiter?: AbuseLimiter): Promise<FastifyInstance> {
  return createApp({
    config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: {
        isReachable: () => Promise.resolve(true),
        hasCurrentSchema: () => Promise.resolve(true),
      },
      publicInquiries: dependencies,
      ...(limiter === undefined ? {} : { limiter }),
    },
  });
}

const contact = {
  kind: "contact", name: "Maria Santos", email: "maria@example.ph", topic: "Sales",
  subject: "Pricing for a law office", message: "We are twelve lawyers. How does Business work?",
  consent: true,
};
const send = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: "POST", url: "/public/inquiries", payload: payload as object });

let app: FastifyInstance;
beforeEach(async () => {
  stored = [];
  transact.mockReset();
  app = await buildApp();
});

describe("POST /public/inquiries", () => {
  it("stores a message with no credential and answers with a receipt only", async () => {
    const response = await send(app, contact);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      inquiryId: "pin_1", kind: "contact", receivedAt: "2026-10-02T09:00:00.000Z",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "contact", name: "Maria Santos", email: "maria@example.ph" });
    // Nothing the visitor typed comes back.
    expect(response.body).not.toContain("maria@example.ph");
    expect(response.body).not.toContain("twelve lawyers");
  });

  it("sets no cookie: sending a message is not signing in", async () => {
    const response = await send(app, contact);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("accepts a demo request and a waitlist sign-up", async () => {
    expect((await send(app, {
      kind: "demo", name: "Jose Cruz", email: "jose@example.ph", organization: "Cruz & Partners",
      topic: "esignature", consent: true,
    })).statusCode).toBe(201);
    expect((await send(app, {
      kind: "waitlist", name: "Lea Ramos", email: "lea@example.ph", topic: "notary", consent: true,
    })).statusCode).toBe(201);
    expect(stored.map(i => i.kind)).toEqual(["demo", "waitlist"]);
  });

  it.each([
    ["no consent", { ...contact, consent: false }],
    ["consent left out", { ...contact, consent: undefined }],
    ["an unknown kind", { ...contact, kind: "newsletter" }],
    ["a field it does not know", { ...contact, isAdmin: true }],
    ["a message past the limit", { ...contact, message: "x".repeat(4001) }],
    ["a name past the limit", { ...contact, name: "x".repeat(121) }],
    ["no name", { ...contact, name: undefined }],
  ])("refuses %s at the wire, storing nothing", async (_label, payload) => {
    const response = await send(app, payload);
    expect(response.statusCode).toBe(422);
    expect(stored).toEqual([]);
  });

  it("refuses what the use case refuses, as a validation error", async () => {
    const response = await send(app, { ...contact, message: "Hi" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(stored).toEqual([]);
  });

  it("is limited by address, and a refused request stores nothing", async () => {
    const check = vi.fn<AbuseLimiter["check"]>(() => Promise.resolve({
      allowed: false, policyId: "public-inquiry.submit.ip", retryAfterSeconds: 3600,
    } as never));
    const limited = await buildApp({ check });
    const response = await send(limited, contact);
    expect(response.statusCode).toBe(429);
    expect(stored).toEqual([]);
    const [checks] = check.mock.calls[0] ?? [];
    expect(checks?.map(c => [c.policy.id, c.scope.type])).toEqual([["public-inquiry.submit.ip", "ip"]]);
    await limited.close();
  });

  it("has no reading route outside a session", async () => {
    // The inbox routes live in the authenticated scope, which this app does
    // not have: an anonymous caller finds nothing to read.
    expect((await app.inject({ method: "GET", url: "/public-inquiries" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/public/inquiries" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/public-inquiries/pin_1" })).statusCode).toBe(404);
  });
});
