// The FLOWING-document-generation seam (070, replacing 066's fixed-canvas one).
//
// Produces the BYTES of a template's own document from an authored
// `FlowDocument` — the counterpart to an upload, same as 066's port was.
// `attachWorkflowTemplateDocument` still owns attaching a document/artifact
// pair to a template; this port only answers "lay this document out and
// render it", the same separation `FieldMerger` and `DocumentSealer` keep
// between rendering and persistence.
//
// ── The one thing 066's port could not do ───────────────────────────────────
//
// This ALSO resolves every `fieldAnchor` in the document to where the layout
// actually placed it. That is new: a fixed-canvas block never needed
// resolving because the admin had already chosen its rectangle. A flowing
// document's anchors are typed inline and land wherever the surrounding text
// pushes them, so "where is it" is an OUTPUT of rendering, not an input —
// which is why `resolvedAnchors` sits on the result, in the same document
// order the anchors were written in, ready to write through to
// `workflow_template_fields` unchanged.

import type {
  FlowDocument, Sha256Digest, PreparationFieldType, PreparationRect,
} from "@lagda/contracts";

export interface GenerateFlowDocumentRequest {
  readonly content: FlowDocument;
  /** Pinned by the caller so two renders of the same content are
   *  byte-identical, the same reason `mergedAt` is supplied rather than read
   *  from a clock in `FieldMerger`. */
  readonly generatedAt: number;
}

/** One `fieldAnchor` run, resolved to its actual page and rectangle. Shaped
 *  to slot directly into a `WorkflowTemplateFieldInput` — see the contract's
 *  own `ResolvedFieldAnchorSchema` doc comment. */
export interface ResolvedFlowFieldAnchor {
  readonly fieldType: PreparationFieldType;
  readonly slotId?: string;
  readonly variableKey?: string;
  readonly required: boolean;
  readonly label: string;
  readonly pageNumber: number;
  readonly rect: PreparationRect;
}

export interface GenerateFlowDocumentResult {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly pageCount: number;
  /** In document order. */
  readonly resolvedAnchors: readonly ResolvedFlowFieldAnchor[];
}

export interface FlowDocumentGenerator {
  generate(request: GenerateFlowDocumentRequest): Promise<GenerateFlowDocumentResult>;
}
