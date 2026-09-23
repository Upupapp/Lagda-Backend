// The template-document-generation seam (066).
//
// Produces the BYTES of a template's own document from authored content — the
// counterpart to an upload. `attachWorkflowTemplateDocument` still owns
// attaching a document/artifact pair to a template; this port only answers
// "render these blocks onto this many blank pages", the same separation
// `FieldMerger` and `DocumentSealer` already keep between rendering and
// persistence.

import type { TemplateContentBlock } from "@lagda/contracts";
import type { Sha256Digest } from "@lagda/contracts";

export interface GenerateTemplateDocumentRequest {
  readonly pageCount: number;
  readonly blocks: readonly TemplateContentBlock[];
  /** Pinned by the caller so two renders of the same blocks are
   *  byte-identical, the same reason `mergedAt` is supplied rather than read
   *  from a clock in `FieldMerger`. */
  readonly generatedAt: number;
}

export interface GenerateTemplateDocumentResult {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly pageCount: number;
}

export interface TemplateDocumentGenerator {
  generate(request: GenerateTemplateDocumentRequest): Promise<GenerateTemplateDocumentResult>;
}
