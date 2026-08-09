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
}
