// The public document verification surface (BACKEND-42).
//
//   GET  /public/verifications/:verificationId              no credential
//   POST /public/verifications/:verificationId/file-check   no credential
//
// ── The only endpoints in LAGDA reachable with NO credential at all ────────
//
// Not an account, not an invitation, not a signing link. Every other public
// path in this codebase carries something — the bootstrap route holds a signing
// credential in its body, the invitation preview holds a token. These hold
// nothing but an identifier that authorizes nothing.
//
// That shapes every decision here:
//
//   - `WorkspaceAccessContext` does not appear in this file and must not.
//   - No session, no CSRF, no cookie is read or written.
//   - The response is a curated projection, never a database row.
//   - Absent, malformed, restricted and not-completed all answer identically,
//     because a caller who can tell them apart has an oracle for other
//     people's documents.
//
// ── What a VerificationId is NOT ───────────────────────────────────────────
//
// Not a download token. Neither route returns document bytes, a storage key or
// a URL, and there is no route in this file that could. Verification tells you
// what LAGDA recorded; it does not hand over the file.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  getPublicVerification, compareUploadedFile, policyById,
  type PublicVerificationDependencies, type RateLimitCheck,
} from "@lagda/application";
import type { Sha256Digest } from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import { hashStream, MAX_VERIFICATION_FILE_BYTES } from "./verification-file.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const ParamsSchema = Type.Object({
  // Bounded here as well as parsed in the use case. The route rejects an
  // absurd path segment before anything downstream allocates for it.
  verificationId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

/**
 * The public response.
 *
 * An explicit shape, not a serialized record. Every field was chosen; nothing
 * arrives because it happened to be on the row.
 */
const VerificationResponseSchema = Type.Object({
  schemaVersion: Type.String(),
  verificationId: Type.String(),
  completedAt: Type.Number(),
  participantCount: Type.Number(),
  finalDocument: Type.Object({
    digestAlgorithm: Type.Literal("sha-256"),
    digest: Type.String(),
  }, { additionalProperties: false }),
  seal: Type.Object({
    scheme: Type.String(),
    version: Type.Number(),
    digestAlgorithm: Type.Literal("sha-256"),
    description: Type.String(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const FileCheckResponseSchema = Type.Object({
  verificationId: Type.String(),
  matches: Type.Boolean(),
  digestAlgorithm: Type.Literal("sha-256"),
  authoritativeDigest: Type.String(),
  uploadedDigest: Type.String(),
}, { additionalProperties: false });

/**
 * The not-found body, shared by both routes.
 *
 * Deliberately says nothing about WHY. No "expired", no "cancelled", no "this
 * workspace is archived" — §19.
 */
const NOT_FOUND = {
  error: {
    code: "verification_record_not_found",
    message: "No completed LAGDA verification record was found for this reference.",
  },
} as const;

export interface PublicVerificationRouteOptions {
  readonly deps: PublicVerificationDependencies;
  readonly metrics: MetricsRecorder;
  readonly rateLimit: RateLimitOptions;
}

function limits(
  request: FastifyRequest,
  policy: "public-verification.lookup.ip" | "public-verification.file-check.ip",
  options: PublicVerificationRouteOptions,
): Promise<void> {
  // IP is the only scope available: there is no account, no session and no
  // credential to scope by.
  const checks: RateLimitCheck[] = [{
    policy: policyById(policy),
    scope: { type: "ip", ipAddress: request.ip },
  }];
  return checkSemanticLimits(request, checks, options.rateLimit);
}

export function registerPublicVerificationRoutes(
  app: FastifyInstance,
  options: PublicVerificationRouteOptions,
): void {
  // ── ID lookup ─────────────────────────────────────────────────────────────
  app.get<{ Params: { verificationId: string } }>(
    "/public/verifications/:verificationId",
    {
      schema: {
        params: ParamsSchema,
        response: { 200: VerificationResponseSchema },
      },
    },
    async (request, reply) => {
      await limits(request, "public-verification.lookup.ip", options);

      const result = await getPublicVerification(
        request.params.verificationId, options.deps);

      // Never cached. The record is immutable, so caching would be safe for the
      // metadata — but a shared proxy holding verification responses is a
      // privacy surface nobody has reviewed, and §113 says not until the
      // disclosure model is mature.
      void reply.header("Cache-Control", "no-store");

      // Bounded label. The identifier is never a metric label (§112).
      options.metrics.increment("public_verification_requests_total", {
        result: result.outcome, mode: "id-lookup",
      });

      if (result.outcome === "not-found") {
        return reply.code(404).send(NOT_FOUND);
      }
      return reply.code(200).send(result.view);
    },
  );

  // ── File comparison ───────────────────────────────────────────────────────
  app.post<{ Params: { verificationId: string } }>(
    "/public/verifications/:verificationId/file-check",
    {
      schema: {
        params: ParamsSchema,
        response: { 200: FileCheckResponseSchema },
      },
      // The raw body is consumed as a stream by the handler; Fastify must not
      // buffer or parse it. A JSON parser would load the whole PDF into memory
      // before anything checked its size.
      bodyLimit: MAX_VERIFICATION_FILE_BYTES,
    },
    async (request, reply) => {
      await limits(request, "public-verification.file-check.ip", options);
      void reply.header("Cache-Control", "no-store");

      // §159: resolve the REFERENCE first, so an unknown one costs a row lookup
      // rather than a full-file hash. An attacker who wants to burn CPU has to
      // supply a valid reference, which they are unlikely to hold.
      const known = await getPublicVerification(
        request.params.verificationId, options.deps);
      if (known.outcome === "not-found") {
        options.metrics.increment("public_verification_file_checks_total", {
          result: "not-found", mode: "file-check",
        });
        return reply.code(404).send(NOT_FOUND);
      }

      // Streamed and discarded. No Document row, no Artifact row, no object
      // storage — the bytes exist only inside `hashStream` and are never
      // written anywhere (§66-§70).
      let uploadedDigest: Sha256Digest;
      try {
        uploadedDigest = await hashStream(request.raw);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "file-too-large";
        options.metrics.increment("public_verification_file_checks_total", {
          result: tooLarge ? "too-large" : "invalid", mode: "file-check",
        });
        return reply.code(tooLarge ? 413 : 400).send({
          error: {
            code: tooLarge ? "verification_file_too_large" : "verification_file_invalid",
            message: tooLarge
              ? "The file is larger than public verification accepts."
              : "The file could not be read.",
          },
        });
      }

      const result = await compareUploadedFile(
        { rawVerificationId: request.params.verificationId, uploadedDigest },
        options.deps);

      if (result.outcome === "not-found") {
        return reply.code(404).send(NOT_FOUND);
      }

      // A MISMATCH IS A 200. The comparison succeeded; the bytes differ (§168).
      // Returning an error status would tell a caller their request was wrong
      // when it was answered correctly — and would invite a UI to render it as
      // a failure rather than as a result.
      options.metrics.increment("public_verification_file_checks_total", {
        result: result.matches ? "match" : "mismatch", mode: "file-check",
      });
      return reply.code(200).send({
        verificationId: request.params.verificationId,
        matches: result.matches,
        digestAlgorithm: result.digestAlgorithm,
        authoritativeDigest: result.authoritativeDigest,
        uploadedDigest: result.uploadedDigest,
      });
    },
  );
}
