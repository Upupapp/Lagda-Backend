// The identity surface: that it is mounted at all, and where.

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerIdentityRoutes, IDENTITY_PATHS } from "./identity-routes.js";
import { loadApiConfig } from "../config/index.js";

/**
 * Throws on any use. These tests assert ROUTING, and a stub that answered would
 * let a mounted-but-broken route pass as a mounted one.
 */
function stub<T>(name: string): T {
  return new Proxy({}, {
    get: () => () => { throw new Error(`${name} was called`); },
  }) as T;
}

function app() {
  const instance = Fastify();
  const config = loadApiConfig({
    NODE_ENV: "test", PORT: "3000", CORS_ORIGINS: "https://app.lagda.test",
  });

  registerIdentityRoutes(instance, config, {
    register: () => stub("register"),
    login: () => stub("login"),
    verifyEmail: () => stub("verifyEmail"),
    resendVerification: () => stub("resendVerification"),
    requestPasswordReset: () => stub("requestPasswordReset"),
    resetPassword: () => stub("resetPassword"),
    completeMfa: () => stub("completeMfa"),
    beginEnrolment: () => stub("beginEnrolment"),
    confirmEnrolment: () => stub("confirmEnrolment"),
    disableMfa: () => stub("disableMfa"),
    currentUser: () => stub("currentUser"),
    updateProfile: () => stub("updateProfile"),
    updatePreferences: () => stub("updatePreferences"),
    changePassword: () => stub("changePassword"),
    listSessions: () => stub("listSessions"),
    revokeSession: () => stub("revokeSession"),
    revokeOtherSessions: () => stub("revokeOtherSessions"),
    endSession: () => Promise.resolve(),
    issueSession: () => Promise.resolve({
      sessionToken: "t", csrfToken: "c", expiresAt: 0,
    }),
    authenticatedUser: () => Promise.resolve(null),
  });

  return instance;
}

describe("the identity surface is mounted", () => {
  it("publishes a route that can create an account", async () => {
    // The integration sweep's finding, as an executable check. 38 paths shipped
    // with no way to register, and nothing failed -- because every individual
    // piece was correct and none of them was connected.
    const instance = app();
    await instance.ready();

    const routes = instance.printRoutes({ commonPrefix: false });
    expect(routes).toContain("register");
  });

  it("publishes a route that can issue a session", async () => {
    const instance = app();
    await instance.ready();

    expect(instance.printRoutes({ commonPrefix: false })).toContain("sessions");
  });

  it("mounts every declared path", async () => {
    // Asserted against the constant rather than a hand-written list, so adding
    // a path to IDENTITY_PATHS without registering it fails here.
    const instance = app();
    await instance.ready();
    const routes = instance.printRoutes({ commonPrefix: false });

    for (const path of Object.values(IDENTITY_PATHS)) {
      const leaf = path.split("/").filter(Boolean).at(-1) ?? path;
      expect({ path, mounted: routes.includes(leaf) })
        .toEqual({ path, mounted: true });
    }
  });
});

describe("paths are contract, not configuration", () => {
  it("is a frozen constant with no environment read", () => {
    // A deployment does not choose where sign-in lives. These strings are baked
    // into a generated client, and a configurable one would let two
    // environments disagree about the API they claim to implement.
    expect(IDENTITY_PATHS.signIn).toBe("/auth/sessions");
    expect(IDENTITY_PATHS.register).toBe("/auth/register");
    expect(Object.values(IDENTITY_PATHS).every(p => p.startsWith("/auth/")))
      .toBe(true);
  });
});

describe("placement", () => {
  it("registers no session requirement of its own", async () => {
    // Every route here is either reached without a session or issues one.
    // Inside an authenticated scope, requireSession would reject the caller
    // before sign-in could run -- refusing everyone who has not yet done the
    // thing the scope exists to require.
    const instance = app();
    await instance.ready();

    // Anonymous POST to sign-in reaches the HANDLER (which throws on its stub)
    // rather than being refused at the scope.
    const response = await instance.inject({
      method: "POST", url: IDENTITY_PATHS.signIn,
      payload: { email: "a@b.test", password: "x" },
    });
    expect(response.statusCode).not.toBe(401);
  });
});
