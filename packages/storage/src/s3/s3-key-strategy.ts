// Object key construction.
//
// Keys are built from LAGDA identifiers and nothing else. In particular, never
// from a customer filename: "Complaint against <name> - confidential.pdf" as an
// object key publishes the subject of a legal document into provider access
// logs, admin consoles and billing exports, none of which are LAGDA's to
// control (INV-209).

import {
  toStorageObjectKey, type StorageKeyStrategy, type StorageObjectRef,
} from "@lagda/application";

/**
 * Layout:
 *
 *   workspaces/{workspaceId}/documents/{documentId}/artifacts/{artifactId}.pdf
 *   quarantine/{workspaceId}/uploads/{uploadId}
 *
 * Every segment is an opaque LAGDA identifier. The shape buys operational
 * things — listing one workspace, scoping a lifecycle rule, spotting a stray
 * object — and buys NO authorization. A prefix is a naming convention; the
 * tenant-scoped repository is the control (INV-207).
 *
 * The artifact id is the leaf, not the document id, because one document has
 * several byte-distinct artifacts: `original`, `sealed`, `completion-
 * certificate`. Keying by document would make the second artifact overwrite the
 * first, which is exactly the failure the immutability rules exist to prevent.
 *
 * `.pdf` is present for operator clarity when browsing a bucket. It is a label,
 * never evidence of type — BACKEND-18 decides media type from magic bytes
 * (§19).
 */
export function createStorageKeyStrategy(): StorageKeyStrategy {
  return {
    artifactKey({ workspaceId, documentId, artifactId }): StorageObjectRef {
      assertKeySegment(workspaceId, "workspaceId");
      assertKeySegment(documentId, "documentId");
      assertKeySegment(artifactId, "artifactId");
      return {
        zone: "artifacts",
        key: toStorageObjectKey(
          `workspaces/${workspaceId}/documents/${documentId}/artifacts/${artifactId}.pdf`,
        ),
      };
    },

    quarantineKey({ workspaceId, uploadId }): StorageObjectRef {
      assertKeySegment(workspaceId, "workspaceId");
      assertKeySegment(uploadId, "uploadId");
      // An UPLOAD id, deliberately not an artifact id. Untrusted bytes do not
      // get the identity of an accepted artifact; promotion mints a fresh one
      // once validation has actually happened (§163).
      return {
        zone: "quarantine",
        key: toStorageObjectKey(`quarantine/${workspaceId}/uploads/${uploadId}`),
      };
    },
  };
}

/** Identifier segments are opaque and bounded. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Rejects an identifier that could alter the key's shape.
 *
 * These identifiers are LAGDA-generated, so a failure here is a bug rather than
 * an attack — but the check is cheap and it is the difference between a
 * malformed id producing a loud error and producing a key in a neighbouring
 * workspace's prefix. Note the separator is excluded: an id containing `/`
 * would silently add a path segment.
 */
function assertKeySegment(value: string, name: string): void {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new TypeError(
      `Storage key segment ${name} must be an opaque identifier of 1-64 characters `
      + "using letters, digits, hyphen or underscore.",
    );
  }
}
