// The Node implementation of the completion certificate seam (BACKEND-40).
//
// The completion pipeline's `certificate` step calls this and nothing else. It
// renders a curated `CompletionCertificateModelV1` into a standalone PDF and
// returns the bytes with their digest.
//
// It never invokes `DocumentSealer` (§67), never touches storage, never reads a
// clock, and never sees a database row. Persisting the result as an artifact is
// the step's job, not this adapter's — which is why nothing here mentions an
// `ArtifactId`.

import type {
  CompletionCertificateGenerator,
  CompletionCertificateModelV1,
  CompletionCertificateResult,
} from "@lagda/application";
import { sha256 } from "./internal/digest.js";
import { renderCompletionCertificate } from "./internal/certificate.js";
import {
  COMPLETION_CERTIFICATE_VERSION,
  COMPLETION_CERTIFICATE_RENDERER_VERSION,
} from "@lagda/application";
import { InvalidSealInputError, SealingError, PdfProcessingError } from "./errors/index.js";

export class NodeCompletionCertificateGenerator implements CompletionCertificateGenerator {
  async generate(
    model: CompletionCertificateModelV1,
  ): Promise<CompletionCertificateResult> {
    // A certificate with no participants certifies nothing, and rendering an
    // empty one would produce a plausible-looking document asserting that a
    // signing happened with nobody in it. The builder should never construct
    // this; refusing here means a future builder bug cannot ship it either.
    if (model.participants.length === 0) {
      throw new InvalidSealInputError(
        "A completion certificate must certify at least one participant.",
      );
    }

    // A model produced under a version this build cannot render must not be
    // rendered under the current one — the fields would be interpreted with
    // semantics they were not written with (§76).
    //
    // Widened to `string` deliberately: the field's TYPE is the single current
    // literal, so TypeScript narrows this comparison to `never` and would let
    // the check be deleted as dead. It is not dead — a model can arrive from a
    // persisted row or a future producer, where the type says nothing.
    const version: string = model.certificateVersion;
    if (version !== COMPLETION_CERTIFICATE_VERSION) {
      throw new InvalidSealInputError(
        `This build renders ${COMPLETION_CERTIFICATE_VERSION}, not ${version}.`,
      );
    }

    const certificate = await this.render(model);

    return {
      certificate,
      mediaType: "application/pdf",
      // Observed from the bytes, never claimed by a caller (§219).
      sizeBytes: certificate.byteLength,
      digestAlgorithm: "sha-256",
      // Computed from the EXACT bytes returned above, after rendering. §95: this
      // digest is artifact metadata and is deliberately not inside the document
      // — a certificate cannot contain its own hash without circularity.
      digest: sha256(certificate),
      certificateVersion: COMPLETION_CERTIFICATE_VERSION,
      rendererVersion: COMPLETION_CERTIFICATE_RENDERER_VERSION,
    };
  }

  private async render(model: CompletionCertificateModelV1): Promise<Uint8Array> {
    try {
      return await renderCompletionCertificate(model);
    } catch (cause) {
      // Coverage and unknown-method refusals are already LAGDA-owned, specific
      // and TERMINAL. Rewrapping them as a generic processing failure would
      // lose which fact could not be rendered AND flip them retryable, so the
      // pipeline would retry a certificate that can never render.
      if (cause instanceof SealingError) throw cause;
      // Never carries the model. §243: a renderer error must not serialize
      // recipient names, addresses or evidence into a message that is logged.
      throw new PdfProcessingError("Failed to render the completion certificate.", cause);
    }
  }
}
