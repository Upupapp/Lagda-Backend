// The folder tree over HTTP.
//
// One route, reads only. Creating, renaming and archiving folders each carry
// rules -- depth, cycles, and what becomes of the documents filed inside --
// that live in `@lagda/core/folders` and have no use case yet. Shipping a
// create that skipped them would be worse than shipping neither.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listFolders, type FolderDependencies, type FolderView,
} from "@lagda/application";
import { FolderListSchema, type WorkspaceId } from "@lagda/contracts";

const ParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

export interface FolderRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: string;
    readonly sessionId: string;
  } | null>;
  readonly folderDependencies: () => FolderDependencies;
}

const iso = (ms: number): string => new Date(ms).toISOString();

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
    const actor = await options.authenticatedUser(request);
    if (actor === null) {
      return reply.status(401).send({
        error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
      });
    }

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
}
