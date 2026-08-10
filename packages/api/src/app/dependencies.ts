// What the app needs from the outside world.
//
// A small, CONCRETE, typed object — not a service locator. There is no
// `container.get("DocumentRepository")`: a string key defers a wiring mistake to
// runtime, and the whole value of composition is that the compiler sees it.
//
// Routes receive the specific capability they need, never this whole object,
// so a route cannot reach a dependency it was not given.

import type {
  SessionService, AbuseLimiter,
  CreateWorkspaceDependencies, GetWorkspaceDependencies,
  ListMyWorkspacesDependencies,
  InvitationDependencies, AcceptInvitationDependencies,
  MemberAdministrationDependencies, WorkspaceAccessDependencies,
  ContactDependencies, DocumentDependencies, PreparationDependencies,
  RecipientDependencies, SigningRequestDependencies,
  SendSigningRequestDependencies, SigningAccessDependencies,
  SigningCeremonyDependencies,
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
   * BACKEND-35. Absent in tests that do not exercise the ceremony, exactly as
   * `signingAccess` is - an undefined dependency means the routes are never
   * registered, rather than registered and broken.
   */
  readonly signingCeremony?: () => SigningCeremonyDependencies;

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
   * Documents (BACKEND-29).
   *
   * Optional as a WHOLE, like every surface before it. Present means all four
   * document routes are registered; absent means none is.
   */
  readonly documents?: () => DocumentDependencies;
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
   * Sending a signing request (BACKEND-33).
   *
   * Separate from `signingRequests` because it needs strictly more: a
   * credential factory, a sealer and a link builder, none of which
   * creation touches. A deployment with no signing-delivery key can wire
   * creation and get a working authoring surface; Send then fails loudly
   * at the point of use rather than at boot.
   */
  readonly sendSigningRequest?: () => SendSigningRequestDependencies;
}
