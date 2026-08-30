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
/**
 * Creating a folder.
 *
 * `parentFolderId` is REQUIRED and nullable rather than optional. Null is the
 * workspace root -- a real destination -- and an optional key would let a
 * client omit it and mean either "the root" or "I forgot", which the server
 * cannot tell apart.
 */
export const CreateFolderRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: FOLDER_NAME_MAX_LENGTH }),
    parentFolderId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  },
  { title: "CreateFolderRequest", additionalProperties: false },
);
export type CreateFolderRequest = Static<typeof CreateFolderRequestSchema>;

/**
 * Updating a folder: EXACTLY ONE field, chosen from two.
 *
 * The same rule the document PATCH takes, for the same reason -- renaming and
 * archiving are separate commands with separate rules, and a body carrying
 * both would apply two where the second can fail after the first committed.
 *
 * No `parentFolderId`. MOVING a folder re-parents a whole subtree and can push
 * its descendants past the depth bound even when the folder itself lands
 * legally; that rule is about a subtree, not a node, and does not exist yet.
 * Accepting the field and ignoring it would be worse than refusing it.
 */
export const UpdateFolderRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: FOLDER_NAME_MAX_LENGTH })),
    /** True archives, false restores. Archiving refuses a non-empty folder. */
    archived: Type.Optional(Type.Boolean()),
  },
  {
    title: "UpdateFolderRequest",
    additionalProperties: false,
    minProperties: 1,
    maxProperties: 1,
  },
);
export type UpdateFolderRequest = Static<typeof UpdateFolderRequestSchema>;

export const FolderListSchema = Type.Object(
  { folders: Type.Array(FolderSchema) },
  { title: "FolderList", additionalProperties: false },
);
