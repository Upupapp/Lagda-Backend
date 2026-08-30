// The folder tree over HTTP: read it, add to it, rename, archive and restore.
//
// ── The operation that is missing, and why ─────────────────────────────────
//
// There is no MOVE. Re-parenting a folder drags a whole subtree with it and
// can push its DESCENDANTS past the depth bound even when the folder itself
// lands legally -- a rule about a subtree, which `checkFolderPlacement`
// answers for a node. `UpdateFolderRequestSchema` therefore refuses
// `parentFolderId` outright rather than accepting and ignoring it.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// Authorization happens inside the use cases against a membership row the
// server read, keyed on `document.update` -- the capability that files a
// document. Organising documents is one permission, not two.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listFolders, createFolder, renameFolder, setFolderArchived,
  type FolderDependencies, type FolderView,
} from "@lagda/application";
import {
  FolderSchema, FolderListSchema,
  CreateFolderRequestSchema, UpdateFolderRequestSchema,
  type CreateFolderRequest, type UpdateFolderRequest,
  type WorkspaceId,
} from "@lagda/contracts";

const ParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const FolderParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  folderId: Type.String({ minLength: 1, maxLength: 64 }),
});

export interface FolderRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: string;
    readonly sessionId: string;
  } | null>;
  readonly folderDependencies: () => FolderDependencies;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Folder names are as sensitive as document titles.
 *
 * "Mabini Business Services / 2026 Renewals" identifies a client and a matter
 * just as a title does, so the tree gets the same no-store treatment the
 * documents routes give their responses. The GET was missing it.
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

const present = (folder: FolderView) => ({
  folderId: folder.folderId,
  parentFolderId: folder.parentFolderId,
  name: folder.name,
  createdAt: iso(folder.createdAt),
  archivedAt: folder.archivedAt === null ? null : iso(folder.archivedAt),
});

export function registerFolderRoutes(
  app: FastifyInstance,
  options: FolderRouteOptions,
): void {
  app.get("/workspaces/:workspaceId/folders", {
    schema: { params: ParamsSchema, response: { 200: FolderListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ParamsSchema>;
    const folders = await listFolders(
      { userId: actor.userId, sessionId: actor.sessionId } as never,
      workspaceId as WorkspaceId,
      options.folderDependencies(),
    );

    // Reads are not logged. A navigation tree is fetched on every visit to the
    // documents area, and a line per fetch is noise that hides real events.
    return reply.status(200).send({ folders: folders.map(present) });
  });

  /**
   * A folder write.
   *
   * IDs and outcomes only. **Never the folder name** -- a folder in a legal
   * workspace is named after the client, the matter or the counterparty,
   * which is the same disclosure §129 keeps document titles out of logs for.
   */
  const record = (
    request: FastifyRequest,
    event: "folder.created" | "folder.renamed" | "folder.archived" | "folder.restored",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null ? null : { userId: actor.userId, sessionId: actor.sessionId };
  };

  app.post("/workspaces/:workspaceId/folders", {
    schema: {
      params: ParamsSchema,
      body: CreateFolderRequestSchema,
      response: { 201: FolderSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ParamsSchema>;
    const body = request.body as CreateFolderRequest;

    const folder = await createFolder(
      actor as never, workspaceId as WorkspaceId,
      { name: body.name, parentFolderId: body.parentFolderId },
      options.folderDependencies());

    record(request, "folder.created", {
      workspaceId, folderId: folder.folderId,
      parentFolderId: folder.parentFolderId,
      actorUserId: actor.userId,
    });

    // Location, as the document create does: the new resource is addressable
    // even though this API has no single-folder GET.
    return reply
      .status(201)
      .header("location", `/workspaces/${workspaceId}/folders/${folder.folderId}`)
      .send(present(folder));
  });

  app.patch("/workspaces/:workspaceId/folders/:folderId", {
    schema: {
      params: FolderParamsSchema,
      body: UpdateFolderRequestSchema,
      response: { 200: FolderSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, folderId } = request.params as Static<typeof FolderParamsSchema>;
    const body = request.body as UpdateFolderRequest;

    // `in`, not truthiness: `archived: false` is a RESTORE, and every shorthand
    // for "is it set" reads false as absent -- which would silently turn a
    // restore into a rename with no name.
    if ("archived" in body) {
      const archived = body.archived ?? false;
      const folder = await setFolderArchived(
        actor as never, workspaceId as WorkspaceId, folderId, archived,
        options.folderDependencies());

      record(request, archived ? "folder.archived" : "folder.restored", {
        workspaceId, folderId, actorUserId: actor.userId,
      });
      return reply.status(200).send(present(folder));
    }

    const folder = await renameFolder(
      actor as never, workspaceId as WorkspaceId, folderId,
      // Narrowed by the schema: exactly one key, and it is not `archived`.
      body.name as string,
      options.folderDependencies());

    record(request, "folder.renamed", {
      workspaceId, folderId, actorUserId: actor.userId,
    });
    return reply.status(200).send(present(folder));
  });
}
