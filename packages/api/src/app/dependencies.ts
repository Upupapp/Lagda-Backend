// What the app needs from the outside world.
//
// A small, CONCRETE, typed object — not a service locator. There is no
// `container.get("DocumentRepository")`: a string key defers a wiring mistake to
// runtime, and the whole value of composition is that the compiler sees it.
//
// Routes receive the specific capability they need, never this whole object,
// so a route cannot reach a dependency it was not given.

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
}
