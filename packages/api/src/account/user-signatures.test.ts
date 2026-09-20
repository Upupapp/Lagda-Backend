// The saved-signature surface.
//
// The properties under test are the ones that would matter at the moment
// someone signs: that the library cannot accept an image the ceremony would
// refuse, that an opaque image is refused before it can paint a white box over
// a document, and that a write without a CSRF token does not happen.
//
// PNG fixtures are BUILT here rather than pasted as base64, because a test
// whose fixture is an opaque blob cannot show you why it is opaque — and the
// whole subject of these tests is a single byte in the header.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { deflateSync } from "node:zlib";
import type {
  GetCurrentUserDependencies, UpdateProfileDependencies,
  UpdatePreferencesDependencies, ChangePasswordDependencies,
  ListSessionsDependencies, RevokeSessionDependencies,
  RevokeOtherSessionsDependencies, CurrentUser, PasswordHash,
  SessionId, UserId,
} from "@lagda/application";
import type { UserSignatureRepository, SavedSignature } from "@lagda/db";
import type { ApiConfig } from "../config/index.js";
import { registerAccountRoutes } from "./account-routes.js";
import { createSignatureImageValidator } from "../security/signature-image.js";

const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

// ── A PNG, built a byte at a time ──────────────────────────────────────────

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(tag: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * @param colourType 6 = RGB+alpha, 2 = RGB (no alpha), 3 = palette, 4 = grey+alpha
 * @param withTrns   palette images carry transparency only via a tRNS chunk
 */
function makePng(colourType: number, withTrns = false, size = 8): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = colourType;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const perRow = size * (channels[colourType] ?? 1);
  const raw = Buffer.concat(
    Array.from({ length: size }, () => Buffer.alloc(perRow + 1)),
  );
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (colourType === 3) parts.push(chunk("PLTE", Buffer.from([0, 0, 0])));
  if (withTrns) parts.push(chunk("tRNS", Buffer.from([0])));
  parts.push(chunk("IDAT", deflateSync(raw)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const RGBA = makePng(6).toString("base64");
const OPAQUE_RGB = makePng(2).toString("base64");
const GREY_ALPHA = makePng(4).toString("base64");
const PALETTE_OPAQUE = makePng(3).toString("base64");
const PALETTE_TRNS = makePng(3, true).toString("base64");

// ── Harness ────────────────────────────────────────────────────────────────

function currentUser(): CurrentUser {
  return {
    userId: "usr_1" as UserId,
    email: "Real.User@Example.com",
    emailVerified: true,
    profile: {
      fullName: "Real User", displayName: "Real",
      jobTitle: null, department: null, preferredSenderName: null,
    },
    preferences: {
      timezone: "Asia/Manila", locale: "en-PH", language: "en",
      dateFormat: "DD/MM/YYYY", timeFormat: "24h", numberFormat: "comma-dot",
      appearance: "system", density: "comfortable", documentListView: "table",
    },
    security: { mfaEnabled: false, mfaFactor: null, recoveryCodesRemaining: 0 },
    createdAt: 1_700_000_000_000,
  };
}

const HASH = "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash;

async function build(options: { authenticated?: boolean; csrfValid?: boolean } = {}) {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, allErrors: true } },
  });
  await app.register(cookie);

  const stored = new Map<string, SavedSignature>();
  const signatures: UserSignatureRepository = {
    list: () => Promise.resolve([...stored.values()]),
    find: (_u, purpose) => Promise.resolve(stored.get(purpose) ?? null),
    save: (input) => {
      const row: SavedSignature = {
        userSignatureId: input.userSignatureId,
        purpose: input.purpose,
        representationType: input.representationType,
        typedText: input.typedText,
        typedStyleIndex: input.typedStyleIndex,
        rasterBytes: input.rasterBytes,
        rasterMediaType: input.rasterMediaType,
        rasterWidth: input.rasterWidth,
        rasterHeight: input.rasterHeight,
        digest: input.digest,
        validatedAt: input.validatedAt,
        createdAt: input.now,
        updatedAt: input.now,
      };
      // The real table has UNIQUE (user_id, purpose); this mirrors it.
      stored.set(input.purpose, row);
      return Promise.resolve(row);
    },
    remove: (_u, purpose) => Promise.resolve(stored.delete(purpose)),
  };

  const accounts = {
    findCurrentUser: () => Promise.resolve(currentUser()),
    updateProfile: () => Promise.resolve(true),
    updatePreferences: () => Promise.resolve(true),
  };

  registerAccountRoutes(app, {
    config: CONFIG,
    validateCsrf: () => options.csrfValid !== false,
    signatures: () => signatures,
    signatureImages: () => createSignatureImageValidator(),
    now: () => new Date(1_700_000_000_000),
    authenticatedUser: () => Promise.resolve(
      options.authenticated === false
        ? null
        : { userId: "usr_1" as UserId, sessionId: "ses_1" as SessionId }),
    currentUserDependencies: (): GetCurrentUserDependencies => ({ accounts }),
    updateProfileDependencies: (): UpdateProfileDependencies => ({
      clock: { now: () => 1 }, commit: op => op({ accounts }),
    }),
    updatePreferencesDependencies: (): UpdatePreferencesDependencies => ({
      clock: { now: () => 1 }, isKnownTimezone: () => true,
      commit: op => op({ accounts }),
    }),
    changePasswordDependencies: (): ChangePasswordDependencies => ({
      clock: { now: () => 1 },
      hasher: {
        hash: () => Promise.resolve(HASH),
        verify: () => Promise.resolve(true),
        needsRehash: () => false,
      },
      credentials: { findPasswordHash: () => Promise.resolve(HASH) },
      commit: op => op({
        credentials: {
          findPasswordHash: () => Promise.resolve(HASH),
          replacePasswordHash: () => Promise.resolve(true),
        },
        sessions: {
          listActiveForUser: () => Promise.resolve([]),
          revokeOwnedByUser: () => Promise.resolve(true),
          revokeAllForUserExcept: () => Promise.resolve(0),
        },
      }),
    }),
    listSessionsDependencies: (): ListSessionsDependencies => ({
      sessions: { listActiveForUser: () => Promise.resolve([]) },
    }),
    revokeSessionDependencies: (): RevokeSessionDependencies => ({
      clock: { now: () => 1 },
      sessions: { revokeOwnedByUser: () => Promise.resolve(true) },
    }),
    revokeOtherSessionsDependencies: (): RevokeOtherSessionsDependencies => ({
      clock: { now: () => 1 },
      sessions: { revokeAllForUserExcept: () => Promise.resolve(0) },
    }),
  });
  await app.ready();
  return { app, stored };
}

/**
 * `inject`'s `json()` is `any`. Casting at every call site trips the unsafe-any
 * rules; casting here puts the one unavoidable assertion in one place.
 */
function body<T>(response: { json: () => unknown }): T {
  return response.json() as T;
}

const put = (app: FastifyInstance, purpose: string, body: unknown) =>
  app.inject({ method: "PUT", url: `/me/signatures/${purpose}`, payload: body as object });

// ── Tests ──────────────────────────────────────────────────────────────────

describe("saving a drawn signature", () => {
  it("accepts a PNG that can carry transparency", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: RGBA },
    });
    expect(response.statusCode).toBe(200);
    const saved = body<{ method: string; digest: string }>(response);
    expect(saved.method).toBe("drawn");
    expect(saved.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a fully opaque image", async () => {
    // The sealer embeds with no compositing control, so an opaque PNG paints a
    // rectangle over the document. The signer would never see it: the preview
    // shows their signature and the box appears only in the sealed PDF.
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: OPAQUE_RGB },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "SIGNATURE_IMAGE_OPAQUE" },
    });
  });

  it("tells the refused caller what to do about it", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: OPAQUE_RGB },
    });
    expect(body<{ error: { message: string } }>(response).error.message)
      .toMatch(/transparent background/i);
  });

  it("accepts greyscale-plus-alpha", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: GREY_ALPHA },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a palette image with no tRNS chunk", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: PALETTE_OPAQUE },
    });
    expect(response.statusCode).toBe(422);
  });

  it("accepts a palette image that carries tRNS", async () => {
    // Transparency in a palette PNG lives in a separate chunk, so this case
    // needs the chunk walk rather than the colour-type byte alone.
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: PALETTE_TRNS },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses bytes that are not a PNG at all", async () => {
    // Long enough to clear the schema's minLength, so the refusal comes from
    // the magic-byte check rather than from AJV. A shorter payload is also
    // refused, but at 400 by the schema, which tests a different layer.
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: {
        method: "drawn",
        base64: Buffer.from("this is definitely not a png file at all").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "SIGNATURE_IMAGE_INVALID" },
    });
  });

  it("refuses a payload too short to be anything, at the schema", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: "AAAA" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("stores the decoded bytes, not the transport string", async () => {
    const { app, stored } = await build();
    await put(app, "signature", { representation: { method: "drawn", base64: RGBA } });
    const row = stored.get("signature");
    expect(row?.rasterBytes).toBeInstanceOf(Buffer);
    expect(row?.rasterMediaType).toBe("image/png");
    // Dimensions come from IHDR, never from a client claim.
    expect(row?.rasterWidth).toBe(8);
    expect(row?.rasterHeight).toBe(8);
  });
});

describe("saving a typed signature", () => {
  it("accepts text plus a style index", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "typed", text: "Real User", styleIndex: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ method: "typed", text: "Real User" });
  });

  it("refuses a style index outside the server-known list", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: { method: "typed", text: "Real User", styleIndex: 99 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a font name, because there is nowhere to put one", async () => {
    const { app } = await build();
    const response = await put(app, "signature", {
      representation: {
        method: "typed", text: "Real User", styleIndex: 0,
        fontFamily: "Comic Sans",
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("replacing", () => {
  it("keeps at most one per purpose", async () => {
    const { app, stored } = await build();
    await put(app, "signature", { representation: { method: "typed", text: "One", styleIndex: 0 } });
    await put(app, "signature", { representation: { method: "typed", text: "Two", styleIndex: 0 } });
    expect(stored.size).toBe(1);
    expect(stored.get("signature")?.typedText).toBe("Two");
  });

  it("keeps a signature and initials separately", async () => {
    const { app, stored } = await build();
    await put(app, "signature", { representation: { method: "typed", text: "Real User", styleIndex: 0 } });
    await put(app, "initials", { representation: { method: "typed", text: "RU", styleIndex: 0 } });
    expect(stored.size).toBe(2);
  });
});

describe("authorization", () => {
  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: RGBA },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a write with no valid CSRF token", async () => {
    // /me is registered outside the authenticated scope, so requireSession's
    // CSRF hook never runs here. This route asks for the check itself.
    const { app, stored } = await build({ csrfValid: false });
    const response = await put(app, "signature", {
      representation: { method: "drawn", base64: RGBA },
    });
    expect(response.statusCode).toBe(403);
    expect(stored.size).toBe(0);
  });

  it("still allows reading without a CSRF token", async () => {
    const { app } = await build({ csrfValid: false });
    const response = await app.inject({ method: "GET", url: "/me/signatures" });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a purpose that is not signature or initials", async () => {
    const { app } = await build();
    const response = await put(app, "monogram", {
      representation: { method: "typed", text: "X", styleIndex: 0 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("listing and removing", () => {
  it("lists nothing for a user who has saved nothing", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me/signatures" });
    expect(response.json()).toEqual({ signatures: [] });
  });

  it("returns the stored bytes re-encoded, never a client echo", async () => {
    const { app } = await build();
    await put(app, "signature", { representation: { method: "drawn", base64: RGBA } });
    const response = await app.inject({ method: "GET", url: "/me/signatures" });
    const listed = body<{ signatures: { base64: string }[] }>(response);
    expect(listed.signatures[0]?.base64).toBe(RGBA);
  });

  it("removes one", async () => {
    const { app, stored } = await build();
    await put(app, "signature", { representation: { method: "typed", text: "X", styleIndex: 0 } });
    const response = await app.inject({ method: "DELETE", url: "/me/signatures/signature" });
    expect(response.statusCode).toBe(204);
    expect(stored.size).toBe(0);
  });

  it("treats removing what is not there as success", async () => {
    // The caller's goal — "I have no saved signature" — is satisfied either
    // way, and a 404 would only invite a retry that cannot help.
    const { app } = await build();
    const response = await app.inject({ method: "DELETE", url: "/me/signatures/signature" });
    expect(response.statusCode).toBe(204);
  });

  it("refuses a delete with no valid CSRF token", async () => {
    const { app } = await build({ csrfValid: false });
    const response = await app.inject({ method: "DELETE", url: "/me/signatures/signature" });
    expect(response.statusCode).toBe(403);
  });
});

describe("no user id is expressible", () => {
  it("has no route carrying another user's id", async () => {
    // The boundary is structural rather than a comparison: with no :userId
    // segment, "user A edits user B" is not a request that can be made.
    const { app } = await build();
    const response = await app.inject({
      method: "PUT",
      url: "/me/signatures/signature?userId=usr_2",
      payload: { representation: { method: "typed", text: "X", styleIndex: 0 } },
    });
    // The query string is simply ignored; the row belongs to the session.
    expect(response.statusCode).toBe(200);
  });
});
