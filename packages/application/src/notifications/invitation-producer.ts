// Turning an invitation into a notification.
//
// ── Why this is a function and not a call site ─────────────────────────────
//
// The invitation use case names a business reason and hands over identifiers;
// it does not assemble a message. That separation is BACKEND-44's §96: once
// `sendEmail(...)` appears inside a domain transaction, the answer to "what
// does LAGDA send when somebody is invited" becomes a grep, and changing the
// copy means editing the invitation flow.
//
// ── What it carries, and what it deliberately does not ─────────────────────
//
// A POINTER to the invitation, never the credential and never a URL. The
// credential is sealed on the invitation row, where the row's own lifecycle
// bounds it (OD-184); the link is rebuilt from configuration at send time. A
// URL here would have to live on an immutable notification that could never
// clear it, and would bake a hostname into a durable row.
//
// ── Inside the caller's transaction ────────────────────────────────────────
//
// It takes the transaction and the repositories rather than opening its own, so
// a failure to record the intent rolls the invitation back with it. An
// invitation that exists with no notification is a pending row in a manager's
// list that no email will ever match.

import type {
  NotificationRepository, ActorProfileRepository, ScopedWorkspaceRepository,
  Clock,
} from "../common/ports/index.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type {
  WorkspaceId, UserId, WorkspaceInvitationId,
} from "@lagda/contracts";
import type { NotificationTemplateRegistry } from "./template-registry.js";
import { createNotificationIntent } from "./create-intent.js";

/**
 * Shown when the inviting account can no longer be read.
 *
 * A deleted inviter must not fail an invitation that is otherwise valid, and it
 * must not leave the sentence half-written either. The workspace name still
 * carries the meaning: "you were invited to Reyes Legal".
 */
const UNKNOWN_INVITER = "A workspace administrator";

/** Shown when the workspace row is unreadable. Should not happen; not fatal. */
const UNKNOWN_WORKSPACE = "a LAGDA workspace";

export interface InvitationProducerDependencies {
  readonly templates: NotificationTemplateRegistry;
  readonly ids: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly clock: Clock;
}

export interface InvitationNotificationInput {
  readonly invitationId: WorkspaceInvitationId;
  readonly workspaceId: WorkspaceId;
  readonly invitedByUserId: UserId;
  /**
   * The address the INVITER typed, snapshotted (S22).
   *
   * Passed rather than re-read, because the invitation row froze it and a later
   * profile edit must not redirect a credential-bearing message.
   */
  readonly inviteeEmail: string;
}

export function createInvitationNotificationProducer(
  deps: InvitationProducerDependencies,
) {
  return async (
    input: InvitationNotificationInput,
    repositories: {
      readonly notifications: NotificationRepository;
      readonly workspaces: ScopedWorkspaceRepository;
      readonly actorProfiles: ActorProfileRepository;
    },
    transaction: unknown,
  ): Promise<void> => {
    // Both reads are in the caller's transaction, so the names frozen onto the
    // intent are the ones true at the moment the invitation was created.
    const [workspace, inviter] = await Promise.all([
      repositories.workspaces.find(),
      repositories.actorProfiles.displayNameOf(input.invitedByUserId),
    ]);

    await createNotificationIntent({
      notifications: repositories.notifications,
      templates: deps.templates,
      ids: deps.ids,
      clock: deps.clock,
    })({
      notificationType: "WORKSPACE_INVITATION",
      // The invitation IS the source. One invitation, one logical
      // notification — so a replayed create finds the existing intent rather
      // than minting a second message about the same offer.
      sourceId: input.invitationId,
      scope: { kind: "WORKSPACE", workspaceId: input.workspaceId },
      // The invitation, not the address. The audience is a REFERENCE to the
      // record that owns the offer, so the destination cannot drift from what
      // the invitation actually says.
      audience: { kind: "WORKSPACE_INVITEE", invitationId: input.invitationId },
      destination: input.inviteeEmail,
      templateInput: {
        inviterDisplayName: inviter ?? UNKNOWN_INVITER,
        workspaceName: workspace?.name ?? UNKNOWN_WORKSPACE,
      },
      // A pointer. The credential lives on the invitation row and is resolved
      // at send time by the domain that owns it.
      secretRef: { kind: "CHALLENGE", challengeId: input.invitationId },
    }, transaction);
  };
}
