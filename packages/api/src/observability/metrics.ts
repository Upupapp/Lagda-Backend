// Metrics — a typed catalog and a recorder port. **No exporter.**
//
// ── The §74 decision: option B ──────────────────────────────────────────────
//
// Instrumentation and a central catalog now; the concrete exporter deferred to
// BACKEND-66. Installing `prom-client` or the OpenTelemetry SDK today would add
// a production dependency whose output nothing collects, and the scrape/push
// mechanism is a deployment decision nobody has made.
//
// The status is reported honestly as INSTRUMENTED_NO_EXPORTER. Nothing here
// claims metrics are being gathered.
//
// ── Why the names are a closed union ────────────────────────────────────────
//
// A `record(name: string, …)` API permits
// `increment(`workspace.${workspaceId}.requests`)` — a metric name per tenant,
// which is unbounded cardinality expressed as a name instead of a label. It is
// the same failure the label rules below prevent, and a string parameter cannot
// stop it. A union can.

export const METRIC_NAMES = [
  "http_requests_total",
  "http_request_duration_ms",
  "http_errors_total",
  "application_use_case_duration_ms",
  "application_errors_total",
  "db_operation_duration_ms",
  "db_errors_total",
  "document_seal_duration_ms",
  "document_seal_errors_total",
  "readiness_check_failures_total",
  "security_events_total",
  "rate_limit_checks_total",
  "rate_limit_rejections_total",
  // BACKEND-25. Workspace lifecycle volume — creations and renames.
  "workspace_operations_total",
  // BACKEND-26. Invitation lifecycle volume — created, resent, revoked,
  // accepted, declined.
  "workspace_invitation_operations_total",
  // BACKEND-27. Member administration — role changes and removals.
  "workspace_member_operations_total",
  // BACKEND-28. Address-book writes — created, updated, archived, restored.
  "contact_operations_total",
  // BACKEND-29. Document writes — created, renamed.
  "document_operations_total",
  // BACKEND-30. Preparation layout saves.
  "document_preparation_operations_total",
  // BACKEND-31. Recipient writes - added, updated, removed, reordered.
  "document_recipient_operations_total",
  // BACKEND-32. Signing request creation.
  "signing_request_operations_total",
  // BACKEND-33. Send transitions.
  "signing_request_send_results_total",
  // BACKEND-34. Recipient signing access.
  "signing_access_attempts_total",
  // BACKEND-35. Ceremony entry, document access, consent.
  "signing_ceremony_results_total",
  // BACKEND-27. Capability denials. Successful checks are NOT counted: one
  // series per authorized request is noise, and the interesting signal is a
  // sustained spike in refusals (§183, §186).
  "authorization_denials_total",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * The ONLY label keys permitted, per metric.
 *
 * Every one is bounded by construction: an HTTP method, a normalized route
 * pattern, a status family, a use-case name, an error category.
 *
 * Deliberately absent — and prohibited by INV: `requestId`, `workspaceId`,
 * `userId`, `documentId`, `signingRequestId`, `verificationId`, `email`,
 * `ipAddress`. Each is unbounded, and a time-series database given one produces
 * a series per tenant per resource until it falls over. They are also PII or
 * PII-linked, which is the second reason: metrics are the one telemetry surface
 * that should carry none.
 */
export const METRIC_LABELS = {
  http_requests_total: ["method", "route", "statusFamily", "processRole"],
  http_request_duration_ms: ["method", "route", "processRole"],
  http_errors_total: ["method", "route", "errorCategory", "processRole"],
  application_use_case_duration_ms: ["useCase", "result", "processRole"],
  application_errors_total: ["useCase", "errorCategory", "processRole"],
  db_operation_duration_ms: ["repository", "operation", "result", "processRole"],
  db_errors_total: ["repository", "operation", "errorCategory", "processRole"],
  document_seal_duration_ms: ["sealScheme", "result", "processRole"],
  document_seal_errors_total: ["errorCategory", "processRole"],
  readiness_check_failures_total: ["dependency", "processRole"],
  security_events_total: ["securityEvent", "result", "processRole"],
  // `policy` and `route` are both code-defined and bounded. Deliberately NOT
  // the IP, the account key, the user or the scope digest — every one is
  // unbounded, and an IP label would put personal data in a metrics store.
  rate_limit_checks_total: ["policy", "result", "processRole"],
  rate_limit_rejections_total: ["policy", "route", "processRole"],
  // `operation` is a two-value union in code and `result` is an outcome.
  // Deliberately NOT `workspaceId`, `userId`, `membershipId` or the workspace
  // NAME: the first three are unbounded, and the name is business data that
  // would end up in a metrics store nobody classifies (§126, §185).
  workspace_operations_total: ["operation", "result", "processRole"],
  // `operation` is a five-value union in code and `result` is an outcome.
  // Deliberately NOT `workspaceId`, `userId`, `invitationId`, the invitee
  // EMAIL or the token digest: the first three are unbounded, the fourth is
  // personal data, and the fifth is a credential handle (§208, §279).
  workspace_invitation_operations_total: ["operation", "result", "processRole"],
  workspace_member_operations_total: ["operation", "result", "processRole"],
  // `operation` is a four-value union in code and `result` is an outcome.
  // Deliberately NOT `contactId`, `workspaceId`, or ANY contact field. The
  // contact's email is the one that matters most: a metrics store is retained
  // longer and read more widely than a log, and the address belongs to a
  // counterparty who is not a LAGDA user and consented to nothing.
  contact_operations_total: ["operation", "result", "processRole"],
  // `operation` is a two-value union in code and `result` is an outcome.
  // Deliberately NOT `documentId`, `workspaceId`, `artifactId`, the TITLE or the
  // original filename. The first three are unbounded; the last two are a legal
  // matter name, which identifies a client and a transaction and must not reach
  // a metrics store (§129, §137).
  document_operations_total: ["operation", "result", "processRole"],
  // `operation` is a one-value union today and `result` is an outcome.
  // Deliberately NOT `documentId`, `preparationId`, `fieldId`, the field COUNT,
  // or anything from the layout. The first three are unbounded; a field count
  // as a label would be unbounded too, and the layout itself says where every
  // signature on a contract goes (§188, §193, §194).
  document_preparation_operations_total: ["operation", "result", "processRole"],
  // `operation` is a four-value union and `result` is an outcome.
  //
  // Deliberately NOT `recipientId`, `contactId`, the recipient's NAME, EMAIL or
  // ORGANIZATION, and not the recipient COUNT. The ids are unbounded; the name
  // and email identify a party to a contract and must never reach a metrics
  // store, which is typically retained longer and read more widely than a log
  // (§188, RECIPIENT_DATA_CLASSIFICATION.md).
  //
  // `recipientType` is NOT a label either, despite being a bounded six-value
  // set. Crossed with `operation` and `result` it multiplies the series count
  // for a question - "do senders use approvers" - that a product query answers
  // better than a counter. It appears in the LOG line, where it is read once
  // and in context.
  document_recipient_operations_total: ["operation", "result", "processRole"],
  // `operation` is one value today and `result` is an outcome.
  //
  // Deliberately NOT `signingRequestId`, `documentId`, `workspaceId`, the
  // RECIPIENT COUNT or the FIELD COUNT. The first three are unbounded; the
  // last two are unbounded too and would turn "how many parties does a
  // typical agreement have" into a new time series per answer. Both counts
  // are in the log line, where a number is a number rather than a dimension
  // (§191, §192).
  signing_request_operations_total: ["operation", "result", "processRole"],
  // `result` is an outcome and `routingShape` is a two-value derived label.
  //
  // Deliberately NOT the recipient count, the cohort number, the request id
  // or the workspace id. The first two are unbounded; the last two would
  // make one time series per document. "How many people did that send
  // invite" is a product query, and the number is in the log line.
  //
  // And emphatically not a credential, a digest or a URL - a metric label
  // is the single most widely replicated string in an observability stack.
  signing_request_send_results_total:
    ["result", "routingShape", "processRole"],
  // `operation` is one value today and `result` is a two-value outcome.
  //
  // Deliberately NOT the request id, the recipient id, the workspace id,
  // the IP or any digest. The first three would make one series per
  // document; an IP is PII; and a digest as a metric label would put a
  // credential-derived value in the most widely replicated string store in
  // an observability stack.
  //
  // The failure REASON is also absent, deliberately: the public error is
  // collapsed precisely so a caller cannot distinguish expired from unknown,
  // and a metric that split them would rebuild the oracle for anyone who can
  // read a dashboard.
  signing_access_attempts_total: ["operation", "result", "processRole"],
  // `operation` is a three-value closed set - enter, document, consent - and
  // `result` is two. Deliberately NOT `signingRequestId` or `recipientId`:
  // one time series per document, or per signer, is how a metrics bill and a
  // PII incident happen at the same time. Nor `blocker`: the ceremony error
  // is not an oracle the way BACKEND-34's is, but a dashboard that shows why
  // named signers were refused is still a dashboard nobody meant to build.
  signing_ceremony_results_total: ["operation", "result", "processRole"],
  // `capability` is a ten-value closed set defined in code — bounded, and the
  // most useful dimension a denial has. Deliberately NOT `workspaceId`,
  // `userId` or `membershipId`: all unbounded, and one series per tenant is how
  // a metrics backend falls over (§187, §249).
  authorization_denials_total: ["capability", "processRole"],
} as const satisfies Record<MetricName, readonly string[]>;

export type LabelsFor<N extends MetricName> = Partial<
  Record<(typeof METRIC_LABELS)[N][number], string>
>;

/**
 * The recorder port.
 *
 * Three methods, provider-neutral. No Prometheus type, no OpenTelemetry type —
 * BACKEND-66 implements this against whichever it selects, and nothing that
 * calls it changes.
 */
export interface MetricsRecorder {
  increment<N extends MetricName>(name: N, labels?: LabelsFor<N>, by?: number): void;
  observe<N extends MetricName>(name: N, value: number, labels?: LabelsFor<N>): void;
  gauge<N extends MetricName>(name: N, value: number, labels?: LabelsFor<N>): void;
}

/**
 * Discards everything.
 *
 * The default, so instrumentation can exist and be tested before an exporter
 * does. It is a no-op and is reported as one — nothing pretends collection is
 * happening.
 */
export const noopMetrics: MetricsRecorder = {
  increment: () => undefined,
  observe: () => undefined,
  gauge: () => undefined,
};

/**
 * Records into memory. **Tests and local diagnosis only.**
 *
 * Bounded by the closed name union and the label allowlist, so it cannot grow a
 * series per tenant — but it is still unbounded in distinct label COMBINATIONS
 * and must never be used as a production store (§252).
 */
export function createInMemoryMetrics(): MetricsRecorder & {
  readonly samples: readonly { name: string; value: number; labels: Record<string, string> }[];
} {
  const samples: { name: string; value: number; labels: Record<string, string> }[] = [];
  const push = (name: string, value: number, labels?: Record<string, string | undefined>): void => {
    const defined: Record<string, string> = {};
    for (const [key, item] of Object.entries(labels ?? {})) {
      if (item !== undefined) defined[key] = item;
    }
    samples.push({ name, value, labels: defined });
  };
  return {
    samples,
    increment: (name, labels, by = 1) => { push(name, by, labels); },
    observe: (name, value, labels) => { push(name, value, labels); },
    gauge: (name, value, labels) => { push(name, value, labels); },
  };
}

/**
 * Normalizes a route for use as a label.
 *
 * Fastify supplies the pattern (`/documents/:documentId`); this is the fallback
 * for when it does not. Raw URLs must never become labels — one series per
 * document ID is the textbook cardinality explosion.
 */
export function normalizeRoute(routePattern: string | undefined, rawUrl: string): string {
  if (routePattern !== undefined && routePattern !== "") return routePattern;
  const path = rawUrl.split("?")[0] ?? rawUrl;
  // Anything that looks like an identifier becomes a placeholder.
  return path
    .split("/")
    .map(segment =>
      /^[0-9a-f]{8,}$/i.test(segment) || /^[a-z]+_[A-Za-z0-9]{6,}$/.test(segment)
        ? ":id"
        : segment,
    )
    .join("/") || "/";
}

/** `2xx`, `4xx`, `5xx` — three values, not six hundred. */
export function statusFamily(statusCode: number): string {
  return `${String(Math.floor(statusCode / 100))}xx`;
}
