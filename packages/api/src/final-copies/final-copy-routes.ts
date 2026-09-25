// POST /final-copies/download (073): a participant's copy of the finished
// document, from the link in their completion email.
//
// A POST with the credential in the BODY, not a GET with it in the URL: the
// web page reads the link segment and posts it, so the credential never
// reaches an access log or a referrer. No cookie is set and none is read —
// this is one exchange of a credential for bytes, not a session.

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  downloadFinalCopy, FinalCopyLinkInvalidError, policyById,
  type FinalCopyDownloadDependencies,
} from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

const DownloadBodySchema = Type.Object({
  token: Type.String({ minLength: 43, maxLength: 43 }),
}, {
  title: "FinalCopyDownloadRequest",
  additionalProperties: false,
  description: "The download credential from the completion email's link.",
});

export interface FinalCopyRouteOptions {
  readonly finalCopyDependencies: () => FinalCopyDownloadDependencies;
  readonly rateLimit?: RateLimitOptions;
}

/** A filename a browser will save: the document's own title, made safe. */
function filenameFor(title: string): string {
  const safe = title.replace(/\.pdf$/iu, "").replace(/[^\w .-]+/gu, "").trim().slice(0, 120);
  return `${safe === "" ? "signed-document" : safe} (signed).pdf`;
}

export function registerFinalCopyRoutes(
  app: FastifyInstance,
  options: FinalCopyRouteOptions,
): void {
  app.post("/final-copies/download", {
    schema: { body: DownloadBodySchema },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "private, no-store");
    void reply.header("Pragma", "no-cache");
    void reply.header("Referrer-Policy", "no-referrer");

    if (options.rateLimit !== undefined) {
      await checkSemanticLimits(request, [{
        policy: policyById("final-copy.download.ip"),
        scope: { type: "ip", ipAddress: request.ip },
      }], options.rateLimit);
    }

    const { token } = request.body as Static<typeof DownloadBodySchema>;
    let document;
    try {
      document = await downloadFinalCopy(token, options.finalCopyDependencies());
    } catch (error) {
      // A bounded reason and NEVER the token.
      request.log.info({
        event: "final_copy.download_failed",
        result: error instanceof FinalCopyLinkInvalidError ? "invalid_or_expired" : "error",
      });
      throw error;
    }

    void reply.header("Content-Type", document.mediaType);
    void reply.header("Content-Length", String(document.sizeBytes));
    void reply.header("Content-Disposition",
      `attachment; filename="${filenameFor(document.documentTitle)}"`);
    void reply.header("Accept-Ranges", "none");
    return reply.status(200).send(Readable.from(document.stream));
  });
}
