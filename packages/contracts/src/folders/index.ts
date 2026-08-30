// Folders on the wire.
//
// A document is in ONE folder, so this is a tree of nodes and not a membership
// list. `parentFolderId: null` is the workspace root -- there is one root and
// it is the absence of a parent.

import { Type, type Static } from "@sinclair/typebox";

export const FOLDER_NAME_MAX_LENGTH = 120;

export const FolderSchema = Type.Object(
  {
    folderId: Type.String({ minLength: 1, maxLength: 64 }),
    /** Null is the workspace root. */
    parentFolderId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    name: Type.String({ minLength: 1, maxLength: FOLDER_NAME_MAX_LENGTH }),
    createdAt: Type.String({ format: "date-time" }),
    /**
     * Archived, never dropped -- a folder that vanished would strand every
     * document filed in it. Present in the list and flagged, because a client
     * showing "where is this document" needs it even when archived.
     */
    archivedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  },
  {
    title: "Folder",
    additionalProperties: false,
    description: "A folder in the workspace's document tree.",
  },
);
export type Folder = Static<typeof FolderSchema>;

/**
 * The WHOLE tree, not a page.
 *
 * A client cannot render a breadcrumb from a page of nodes whose parents may
 * be on another page, and folder counts are small by construction: depth is
 * capped at 10 and a workspace files documents, not folders.
 */
export const FolderListSchema = Type.Object(
  { folders: Type.Array(FolderSchema) },
  { title: "FolderList", additionalProperties: false },
);
