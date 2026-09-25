// What the app needs from the outside world.
//
// A small, CONCRETE, typed object — not a service locator. There is no
// `container.get("DocumentRepository")`: a string key defers a wiring mistake to
// runtime, and the whole value of composition is that the compiler sees it.
//
// Routes receive the specific capability they need, never this whole object,
// so a route cannot reach a dependency it was not given.

import type { ProviderWebhookRouteOptions } from "../notifications/provider-webhook-routes.js";
import type { IdentityDependencies } from "./identity-routes.js";
import type {
  PublicVerificationDependencies, ParticipantDocumentDependencies,
} from "@lagda/application";
import type { UploadRouteOptions } from "../upload/upload-route.js";
import type {
  SessionService, AbuseLimiter,
  CreateWorkspaceDependencies, GetWorkspaceDependencies,
  ListMyWorkspacesDependencies,
  InvitationDependencies, AcceptInvitationDependencies,
  MemberAdministrationDependencies, WorkspaceAccessDependencies,
  ContactDependencies,
  UploadRequestDependencies, DocumentDependencies, DocumentContentDependencies, FolderDependencies,
  PreparationDependencies,
  RecipientDependencies, SigningRequestDependencies,
  SendSigningRequestDependencies, SigningAccessDependencies, FinalCopyDownloadDependencies,
  CompletedArtifactDependencies,
  SigningCeremonyDependencies, SigningSubmissionDependencies,
  SigningDeclineDependencies, SigningSkipDependencies, SigningWorkflowDependencies,
  WorkflowTemplateDependencies, WorkflowTemplateGenerateDocumentDependencies,
  AuditTrailDependencies, OrganizationDependencies,
  DocumentNotificationFeedDependencies,
} from "@lagda/application";

/**
 * A bounded liveness probe for readiness.
 *
 * Deliberately narrow: readiness needs to know whether the database answers,
 * not how to query it. Handing the route a `LagdaDatabase` would put a query
 * builder in a route handler, which INV forbids and which would make a
 * readiness check capable of reading tenant data.
 */
export interface DatabaseHealth {
  /** Resolves false rather than throwing. A readiness check must not 500. */
  isReachable(): Promise<boolean>;
  /**
   * Whether every migration this BUILD knows about has been applied.
   *
   * Reachability alone was a false green, and it cost a production outage:
   * the code from a deploy required a column its migration had not created,
   * so every template read failed with `workflow_template_malformed` while
   * `/ready` cheerfully returned `{"status":"ready"}` — because the database
   * was, indeed, reachable.
   *
   * A process that cannot read its own tables must not be in the
   * load-balancer rotation. Resolves false rather than throwing, same
   * contract as `isReachable`.
   */
  hasCurrentSchema(): Promise<boolean>;
}

export interface AppDependencies {
  readonly databaseHealth: DatabaseHealth;
  /**
   * Optional so tests that care only about health and errors need not build a
   * session stack. Absent means no session plugin is registered at all — not a
   * silently-disabled security control, because with no authenticated scope
   * there is nothing to protect.
   */
  /**
   * Recipient signing access (BACKEND-34).
   *
   * TOP-LEVEL, not under `workspaces`, and the placement is the architecture: a
   * recipient has no workspace. Nesting it would put the second authentication
   * realm inside the first.
   */
  readonly signingAccess?: () => SigningAccessDependencies;
  /**
   * 073. A participant's download of the finished document. Absent when the
   * deployment has no object storage — then the route does not exist.
   */
  readonly finalCopies?: () => FinalCopyDownloadDependencies;
  /**
   * Public document verification (BACKEND-42).
   *
   * TOP-LEVEL for the same reason `signingAccess` is, one step further: the
   * caller has no workspace AND no credential of any kind. Nesting it under
   * workspaces would put a completely anonymous surface inside the
   * authenticated realm.
   *
   * Optional, so an app that does not want a public surface simply does not
   * register one — absent means the routes do not exist, never that they exist
   * unprotected.
   */
  readonly publicVerification?: () => PublicVerificationDependencies;
  /** OD-135. Same optionality reasoning as `publicVerification` above. */
  readonly publicParticipantAccess?: () => ParticipantDocumentDependencies;
  /**
   * BACKEND-45. The provider callback surface.
   *
   * Optional, and absent by default in every environment that has not
   * configured a webhook credential. Absent means the route DOES NOT EXIST —
   * never that it exists with authentication disabled, which is the failure
   * mode an "enabled" boolean invites.
   */
  readonly providerWebhook?: () => ProviderWebhookRouteOptions;
  /**
   * The identity surface: registration, sessions, verification, recovery, MFA,
   * account (BACKEND-45 integration sweep, S1).
   *
   * Optional as a WHOLE, and the whole is what matters here more than anywhere
   * else in this object. Registration without sessions is an account nobody
   * can use; sessions without recovery is an account nobody can get back into.
   * A per-group flag would make each of those independently reachable, and each
   * is a half-built product rather than a configuration.
   *
   * Absent means none of it is mounted — which is the state that shipped 38
   * published paths, every one of them assuming a session no route could
   * issue.
   */
  readonly identity?: () => IdentityDependencies;
  /**
   * BACKEND-35. Absent in tests that do not exercise the ceremony, exactly as
   * `signingAccess` is - an undefined dependency means the routes are never
   * registered, rather than registered and broken.
   */
  readonly signingCeremony?: () => SigningCeremonyDependencies;
  /** BACKEND-36. Absent in tests that do not exercise submission. */
  readonly signingSubmission?: () => SigningSubmissionDependencies;
  /**
   * BACKEND-37, routed by OD-154. The recipient's refusal.
   *
   * Same realm and same CSRF validator as submission, its own dependencies:
   * a decline needs the workflow's clock and id generators and none of the
   * signature-image machinery.
   */
  readonly signingDecline?: () => SigningDeclineDependencies;

  /**
   * 069, routed alongside decline. An APPROVER's pass — same realm, same
   * CSRF validator, its own dependencies because it also needs an evidence
   * id generator decline has never needed (see `SigningSkipDependencies`'s
   * own header for why).
   */
  readonly signingSkip?: () => SigningSkipDependencies;

  /**
   * Document upload (BACKEND-17).
   *
   * The route module has existed, with its own tests, since before documents
   * did -- and was never composed. That is why the emitted contract carried no
   * multipart endpoint and why `saveDocumentPreparation` refused every document
   * with `document_has_no_source`: the precondition was real and the only route
   * that could satisfy it was not mounted.
   *
   * Optional like every other group, so absent still means "not composed"
   * rather than a silently disabled control.
   */
  readonly upload?: () => UploadRouteOptions;

  readonly sessions?: SessionService;
  /**
   * The workspace surface (BACKEND-25).
   *
   * Optional as a WHOLE, and the whole is what matters: present means the
   * authenticated scope is built and every workspace route inside it is
   * protected; absent means no workspace route is registered at all. There is
   * no state in which the routes exist and the session requirement does not —
   * which is the failure mode a per-route flag produces.
   *
   * `sessions` is required alongside it. `createApp` refuses to build the scope
   * without one rather than registering routes with authentication silently
   * disabled.
   */
  readonly workspaces?: WorkspaceDependencies;
  /**
   * The abuse limiter, for semantic (per-user) policies.
   *
   * Optional so a test can exercise routing without one. Absent is reported,
   * never implied to be enforcement.
   */
  readonly limiter?: AbuseLimiter;
}

export interface WorkspaceDependencies {
  readonly create: () => CreateWorkspaceDependencies;
  readonly list: () => ListMyWorkspacesDependencies;
  readonly workspace: () => GetWorkspaceDependencies;
  /**
   * Invitations (BACKEND-26).
   *
   * Optional as a WHOLE. Present means the four management routes, the public
   * preview route and the two redemption routes are all registered; absent
   * means none of them is. There is no state in which the accept route exists
   * and the management routes do not, which is what stops a partial wiring
   * producing a surface nobody reviewed as a set.
   */
  readonly invitations?: {
    readonly management: () => InvitationDependencies;
    readonly redemption: () => AcceptInvitationDependencies;
  };
  /**
   * Member administration and the capability projection (BACKEND-27).
   *
   * Optional as a WHOLE, like invitations. Present means the member list, the
   * role-change route, the removal route and the access projection are all
   * registered; absent means none is.
   */
  readonly members?: {
    readonly administration: () => MemberAdministrationDependencies;
    readonly access: () => WorkspaceAccessDependencies;
  };
  /**
   * The address book (BACKEND-28).
   *
   * Optional as a WHOLE, like invitations and members. Present means all six
   * contact routes are registered; absent means none is. A partial wiring would
   * produce a surface nobody reviewed as a set — the case that matters here is
   * `restore` without `archive`, which reads as harmless and is not.
   */
  readonly contacts?: () => ContactDependencies;
  /**
   * 067. Documents this workspace has asked a member to supply.
   *
   * Absent means no route, like every other key here — a deployment that
   * cannot send notifications should not offer a surface whose whole purpose
   * is to notify somebody.
   */
  readonly uploadRequests?: () => UploadRequestDependencies;
  /**
   * Reusable workflow templates (migration 058). Absent means the routes do
   * not exist, the same convention every other optional surface here uses.
   */
  readonly workflowTemplates?: () => WorkflowTemplateDependencies;
  /**
   * Generating a template's OWN document from authored content (066).
   *
   * Separate from `workflowTemplates` because it needs strictly more: object
   * storage and a document generator, the same reason `documentContent` is
   * separate from `documents`. Absent means the generate-document route does
   * not exist; every other template route is unaffected.
   */
  readonly workflowTemplateGenerateDocument?: () => WorkflowTemplateGenerateDocumentDependencies;
  /**
   * Documents (BACKEND-29).
   *
   * Optional as a WHOLE, like every surface before it. Present means all four
   * document routes are registered; absent means none is.
   */
  readonly documents?: () => DocumentDependencies;
  /**
   * Viewing a document's own bytes (BACKEND-29 follow-on).
   *
   * Separate from `documents` because it needs strictly more: object
   * storage, which listing/renaming/filing never touch — same convention as
   * `completedArtifact` below. Absent means no view route exists.
   */
  readonly documentContent?: () => DocumentContentDependencies;
  /**
   * The folder tree (migration 040).
   *
   * Optional as a whole, like every other group. Absent means the route does
   * not exist -- a workspace with no folder surface, rather than one with an
   * unprotected folder surface.
   */
  readonly folders?: () => FolderDependencies;
  /**
   * Document preparation (BACKEND-30).
   *
   * Optional as a WHOLE. Present means both preparation routes are registered;
   * absent means neither is — and a read route without its save route would be
   * an editor that cannot commit.
   */
  readonly preparation?: () => PreparationDependencies;

  /**
   * Signing recipients (BACKEND-31).
   *
   * Optional as a WHOLE, and separate from `preparation` even though the two
   * share a capability: a deployment that wires one and not the other gets a
   * surface where fields can be placed but nobody can be named, which is a
   * misconfiguration worth being able to observe rather than one to make
   * unrepresentable.
   */
  readonly recipients?: () => RecipientDependencies;

  /**
   * Signing requests (BACKEND-32).
   *
   * Optional as a WHOLE. Present means both routes are registered - there is
   * no configuration in which creating a request is possible and reading it
   * back is not.
   */
  readonly signingRequests?: () => SigningRequestDependencies;

  /**
   * The completed, sealed document download (Phase 1-C).
   *
   * Separate from `signingRequests` because it needs strictly more: object
   * storage, which `signingRequests` itself never touches. Absent means no
   * download route exists — the same "absent key = route does not exist"
   * convention as upload and the recipient ceremony, both also storage-gated.
   */
  readonly completedArtifact?: () => CompletedArtifactDependencies;

  /**
   * Sending a signing request (BACKEND-33).
   *
   * Separate from `signingRequests` because it needs strictly more: a
   * credential factory, a sealer and a link builder, none of which
   * creation touches. A deployment with no signing-delivery key can wire
   * creation and get a working authoring surface; Send then fails loudly
   * at the point of use rather than at boot.
   */
  readonly sendSigningRequest?: () => SendSigningRequestDependencies;
  /**
   * The private audit trail for one signing request (BACKEND-43).
   *
   * Optional like every other group. Found UNWIRED by the system sweep: the
   * registrar existed, was exported, and was referenced by nothing, so a
   * workspace could not read its own audit trail over HTTP.
   */
  readonly audit?: () => AuditTrailDependencies;
  /**
   * The in-app DOCUMENT notification feed, projected from evidence.
   *
   * Needs the transaction manager and nothing else, like `audit` — and for
   * the same reason: the actor and the workspace are the use case's INPUT,
   * not its dependencies.
   */
  readonly documentFeed?: () => DocumentNotificationFeedDependencies;
  /**
   * The org chart (TENANT_CORE): departments, offices, teams.
   *
   * Optional as a whole, like every other group. Absent means the routes do not
   * exist, which is a workspace with no hierarchy rather than one with an
   * unprotected hierarchy.
   */
  readonly organization?: () => OrganizationDependencies;
  /** BACKEND-37, routed by OD-154. The sender's withdrawal. */
  readonly cancelSigningRequest?: () => SigningWorkflowDependencies;
}
