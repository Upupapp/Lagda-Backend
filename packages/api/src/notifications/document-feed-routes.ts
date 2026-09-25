// The in-app DOCUMENT notification feed.
//
//   GET  /workspaces/:workspaceId/document-notifications[?scope=mine|workspace]
//   POST /workspaces/:workspaceId/document-notifications/state     (071)
//
// Not `/me/notifications`. That one reads the EMAIL substrate — what we tried
// to send you — and a workspace member's own row there is almost always
// empty, because signing invitations address a recipient and workspace
// invitations address an invitee. This one reads evidence: what has happened
// to this workspace's documents. See `document-feed.ts`'s header.
//
// Workspace-scoped rather than user-scoped for the same reason the audit
// route is: the capability being checked is `signing-request.view`, which is
// held per workspace, and the answer differs per workspace.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getDocumentNotifications, setDocumentNotificationState,
  DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT, MAX_STATE_CHANGE_IDS, DEFAULT_FEED_SCOPE,
  type DocumentNotificationFeedDependencies,
  type SetDocumentNotificationStateDependencies,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";

const ParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const QuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FEED_LIMIT })),
  /** 071. `mine` (the default) or `workspace` — see `DOCUMENT_FEED_SCOPES`. */
  scope: Type.Optional(Type.Union([Type.Literal("mine"), Type.Literal("workspace")])),
}, { additionalProperties: false });

/**
 * 071. A state change for feed rows. Bounded to a feed's worth: "mark all
 * read" sends the rows the client is showing, never an open-ended range.
 * At least one of `read` / `dismissed` must be present.
 */
const StateBodySchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    minItems: 1, maxItems: MAX_STATE_CHANGE_IDS,
  }),
  read: Type.Optional(Type.Boolean()),
  dismissed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const StateResponseSchema = Type.Object({
  /** How many rows the change applied to. */
  updated: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

/**
 * The response, stated as a closed schema.
 *
 * A security boundary rather than documentation, the same as the audit
 * route's: a field added to the view type without being added here is
 * stripped at the wire instead of published.
 */
const NotificationSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  title: Type.String(),
  body: Type.String(),
  severity: Type.Union([
    Type.Literal("info"), Type.Literal("success"),
    Type.Literal("warning"), Type.Literal("critical"),
  ]),
  actionRequired: Type.Boolean(),
  signingRequestId: Type.String(),
  documentTitle: Type.String(),
  recipientName: Type.Union([Type.String(), Type.Null()]),
  occurredAt: Type.Number(),
  /** 071. Whether THIS reader has marked the row read. */
  read: Type.Boolean(),
  /** 071. Whether THIS reader has dismissed the row. */
  dismissed: Type.Boolean(),
}, { additionalProperties: false });

const FeedSchema = Type.Object({
  notifications: Type.Array(NotificationSchema),
}, { additionalProperties: false });

export interface DocumentFeedRouteOptions {
  readonly documentFeedDependencies: () => DocumentNotificationFeedDependencies;
  readonly stateDependencies: () => SetDocumentNotificationStateDependencies;
  readonly actorOf: (request: FastifyRequest) => Promise<{ userId: string } | null>;
  readonly unauthenticated: (reply: FastifyReply) => FastifyReply;
  readonly noStore: (reply: FastifyReply) => void;
}

export function registerDocumentFeedRoutes(
  app: FastifyInstance,
  options: DocumentFeedRouteOptions,
): void {
  app.get("/workspaces/:workspaceId/document-notifications", {
    schema: {
      params: ParamsSchema,
      querystring: QuerySchema,
      response: { 200: FeedSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // A feed is never cached: it is the thing that is supposed to change.
    options.noStore(reply);
    const actor = await options.actorOf(request);
    if (actor === null) return options.unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ParamsSchema>;
    const { limit, scope } = request.query as Static<typeof QuerySchema>;

    // Authorization and tenancy both happen inside the use case's own
    // transaction, as everywhere else — the route performs no role check.
    const notifications = await getDocumentNotifications({
      actor: actor as never,
      workspaceId: workspaceId as WorkspaceId,
      limit: limit ?? DEFAULT_FEED_LIMIT,
      scope: scope ?? DEFAULT_FEED_SCOPE,
    }, options.documentFeedDependencies());

    // Not logged. A feed read is a page refresh, and the document titles it
    // carries are business-sensitive (S160).
    return reply.status(200).send({ notifications });
  });

  // 071. A POST, so the scope's `requireSession` applies its CSRF check —
  // this is the feed's one state change.
  app.post("/workspaces/:workspaceId/document-notifications/state", {
    schema: {
      params: ParamsSchema,
      body: StateBodySchema,
      response: { 200: StateResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    options.noStore(reply);
    const actor = await options.actorOf(request);
    if (actor === null) return options.unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ParamsSchema>;
    const { ids, read, dismissed } = request.body as Static<typeof StateBodySchema>;

    // The reader is the session's user, never a body field: one member
    // cannot change another member's notifications.
    const result = await setDocumentNotificationState({
      actor: actor as never,
      workspaceId: workspaceId as WorkspaceId,
      ids,
      ...(read === undefined ? {} : { read }),
      ...(dismissed === undefined ? {} : { dismissed }),
    }, options.stateDependencies());

    if (result.outcome === "empty-change") {
      return reply.status(422).send({
        error: {
          code: "EMPTY_STATE_CHANGE",
          message: "Say whether to change read, dismissed, or both.",
        },
      });
    }
    return reply.status(200).send({ updated: result.updated });
  });
}
