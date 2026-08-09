// The multipart upload boundary.
//
// ── Order, and why cheap checks come first ─────────────────────────────────
//
//   rate limit  →  session  →  CSRF  →  workspace context  →  multipart
//
// Everything before `multipart` is cheap and rejects without reading a byte of
// the body. That ordering is the difference between refusing an anonymous
// request and letting an attacker use LAGDA as a free malware-scanning and
// PDF-parsing service (§191). It is enforced by hook order — `onRequest` runs
// before the handler, and the body is only consumed inside the handler.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// The product endpoint. `POST /documents` is P0-16 in the implementation
// priority, which belongs to the Documents phase (BACKEND-29). Building it here
// because the machinery is ready would ship a product route ahead of the
// document model it returns (§102). This registers the pipeline behind a
// route so it can be exercised end to end; BACKEND-29 owns the real one.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import {
  processDocumentUpload,
  type UploadDependencies, type UploadLimits, type UploadRejectionReason,
} from "@lagda/application";
import type { DocumentId, WorkspaceId } from "@lagda/contracts";

export interface UploadRouteOptions {
  readonly path: string;
  readonly limits: UploadLimits;
  /**
   * Builds the pipeline's dependencies for one authenticated request.
   *
   * A factory rather than a fixed object because the upload repository is
   * tenant-scoped: it is constructed for the workspace this request resolved,
   * so a handler cannot reach another tenant's rows even by accident.
   */
  readonly dependenciesFor: (context: {
    readonly workspaceId: WorkspaceId;
    readonly userId: string;
  }) => UploadDependencies;
  /**
   * Resolves the trusted tenant/actor for this request.
   *
   * Returns null when the caller may not upload. The route NEVER reads a
   * workspace or user id from a multipart field: a body field is chosen by the
   * client, and letting it name the tenant would be a complete tenancy bypass
   * (INV-224).
   */
  readonly resolveContext: (request: FastifyRequest) => {
    readonly workspaceId: WorkspaceId;
    readonly userId: string;
    /**
     * Which document these bytes belong to.
     *
     * Supplied by the caller because DOCUMENTS DO NOT EXIST YET — there is no
     * `documents` table and no document use case until BACKEND-29. Inventing a
     * document identity here would be inventing the document model, which this
     * command must not do (§131, §132).
     */
    readonly documentId: DocumentId;
  } | null;
}

/**
 * How a rejection reaches the client. Distinct statuses, distinct meanings.
 *
 * Exported because it is a CONTRACT, not an implementation detail: 413 means
 * shrink the file, 415 means wrong type, 503 means retry later. A test that
 * drove six requests would re-test the pipeline instead of the mapping.
 */
export const STATUS_BY_REASON: Record<UploadRejectionReason, number> = {
  // The client sent something LAGDA will not take.
  "file-too-large": 413,
  "empty-file": 422,
  "unsupported-file-type": 415,
  "malformed-pdf": 422,
  "encrypted-pdf-unsupported": 422,
  "too-many-pages": 422,
  // Malware is 422, not a bespoke security status. A distinct code would let an
  // attacker probe LAGDA for which payloads are detected (§145).
  "malware-detected": 422,
  // LAGDA's own failures. The client did nothing wrong and MAY retry.
  "scan-unavailable": 503,
  "integrity-failure": 500,
  "storage-failure": 503,
};

/**
 * Client-facing messages.
 *
 * Deliberately flat and uninformative about internals. "Rejected" tells an
 * attacker nothing about which control fired; the operator gets the detail in
 * structured logs instead (§86).
 */
const MESSAGE_BY_REASON: Record<UploadRejectionReason, string> = {
  "file-too-large": "The file exceeds the maximum upload size.",
  "empty-file": "The file is empty.",
  "unsupported-file-type": "Only PDF documents are supported.",
  "malformed-pdf": "The file could not be read as a valid PDF.",
  "encrypted-pdf-unsupported": "Password-protected PDFs are not supported.",
  "too-many-pages": "The document has too many pages.",
  "malware-detected": "The file was rejected by security scanning.",
  "scan-unavailable": "Uploads are temporarily unavailable. Please try again.",
  "integrity-failure": "The upload could not be completed.",
  "storage-failure": "Uploads are temporarily unavailable. Please try again.",
};

export async function registerUploadRoute(
  app: FastifyInstance,
  options: UploadRouteOptions,
): Promise<void> {
  await app.register(multipart, {
    limits: {
      // EXPLICIT bounds, all of them. A permissive default here is how a
      // multipart endpoint becomes a memory exhaustion primitive (§17).
      fileSize: options.limits.maxBytes,
      // ONE document per request. Extra files are refused rather than ignored,
      // because an ignored second file is content the user believes was
      // received (§18, §19).
      files: 1,
      // Bounded text fields. Thousands of tiny parts cost parsing time and
      // memory without ever carrying a file (§20).
      fields: 10,
      fieldSize: 4 * 1024,
      fieldNameSize: 128,
      parts: 15,
      headerPairs: 200,
    },
    // The file is consumed as a STREAM. `attachFieldsToBody` would buffer every
    // part into the request body first, which is exactly the whole-file
    // buffering the limits above exist to prevent.
    attachFieldsToBody: false,
  });

  app.post(options.path, async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Trusted identity FIRST. Session, CSRF and rate limiting already ran as
    //    onRequest hooks; this is the authorization result, not a body read.
    const context = options.resolveContext(request);
    if (context === null) {
      return reply.status(403).send({
        error: { code: "FORBIDDEN", message: "Not permitted to upload to this workspace." },
      });
    }

    // 2. Only now is the body touched.
    //
    // Every part is iterated, not just the first. `request.file()` returns the
    // FIRST file and silently ignores any others - so a request carrying two
    // files was accepted, with the second never seen by anyone. An ignored file
    // is content the user believes LAGDA received (§19).
    let captured: { bytes: Uint8Array; filename?: string; mimetype?: string } | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        if (captured !== undefined) {
          // Defence in depth. The plugin's `files: 1` limit normally fires
          // first; this covers a configuration where it does not, so the
          // guarantee does not rest on one library's option.
          return reply.status(422).send({
            error: {
              code: "TOO_MANY_FILES",
              message: "Exactly one document may be uploaded per request.",
            },
          });
        }
        const bytes = await readPart(part.file, options.limits.maxBytes);
        if (bytes === null || part.file.truncated) return sendRejection(reply, "file-too-large");
        captured = {
          bytes,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          ...(part.mimetype === undefined ? {} : { mimetype: part.mimetype }),
        };
      }
    } catch (error) {
      // A malformed or over-limit multipart envelope. Mapped to LAGDA's own
      // envelope rather than surfaced as the plugin's error, which carries
      // library wording and no request id (§25).
      const code = (error as { code?: string }).code;
      if (code === "FST_FILES_LIMIT") {
        // The PLUGIN is the primary enforcement here: with `files: 1` it stops
        // at the second file before its bytes are read, which is better than
        // reading them to reject them. Mapped to its own status - it was
        // previously reported as "file too large", which is simply the wrong
        // cause and would send a user to shrink a file that was never the
        // problem.
        return reply.status(422).send({
          error: {
            code: "TOO_MANY_FILES",
            message: "Exactly one document may be uploaded per request.",
          },
        });
      }
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return sendRejection(reply, "file-too-large");
      }
      if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "This endpoint accepts multipart/form-data.",
          },
        });
      }
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "The upload request was malformed." },
      });
    }

    if (captured === undefined) {
      return reply.status(422).send({
        error: { code: "UNPROCESSABLE_ENTITY", message: "No file was provided." },
      });
    }

    const result = await processDocumentUpload(
      {
        // TRUSTED context, never the body. A `workspaceId` field in the
        // multipart payload is ignored entirely — it is not read, so it cannot
        // be forgotten about later (INV-224).
        workspaceId: context.workspaceId,
        uploaderUserId: context.userId,
        documentId: context.documentId,
        content: singleChunk(captured.bytes),
        ...(captured.filename === undefined
          ? {} : { originalFilename: captured.filename }),
        ...(captured.mimetype === undefined
          ? {} : { clientMediaType: captured.mimetype }),
      },
      options.dependenciesFor(context),
      options.limits,
    );

    if (result.outcome === "rejected") {
      return sendRejection(reply, result.reason);
    }

    // The response carries NOTHING internal: no quarantine key, no bucket, no
    // storage reference, no scanner detail (§100, §249).
    return reply.status(201).send({
      uploadId: result.uploadId,
      artifactId: result.artifactId,
      byteSize: result.byteSize,
      mediaType: result.mediaType,
      // Handoff §7 requires these for field placement.
      pageCount: result.pageCount,
      pageSizes: result.pageSizes,
      originalFilename: result.originalFilename,
      digest: result.digest,
    });
  });
}

/**
 * Reads one multipart file part, refusing to exceed the bound.
 *
 * Returns null when the bound is crossed, and stops reading at that point
 * rather than draining the rest — continuing to receive bytes LAGDA has already
 * decided to refuse is free work for an attacker (§24).
 */
async function readPart(
  stream: AsyncIterable<Uint8Array>, maxBytes: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* only(): AsyncGenerator<Uint8Array> { yield bytes; })();
}

function sendRejection(reply: FastifyReply, reason: UploadRejectionReason): FastifyReply {
  return reply.status(STATUS_BY_REASON[reason]).send({
    error: {
      code: reason.toUpperCase().replaceAll("-", "_"),
      message: MESSAGE_BY_REASON[reason],
    },
  });
}
