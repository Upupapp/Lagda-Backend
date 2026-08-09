// Observability behaviour, asserted against captured structured logs.
//
// Every secret used here is synthetic and unmistakable, so a hit is a hit. The
// assertions run against the RAW output as well as parsed fields: a value that
// escaped into a nested object nobody thought to check is still a leak.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { Type } from "@sinclair/typebox";
import { createApp } from "./app/create-app.js";
import { loadApiConfig, type ApiConfig } from "./config/index.js";
import type { AppDependencies } from "./app/dependencies.js";
import { buildLoggerOptions } from "./logging/index.js";
import { createLogCapture, type LogCapture } from "./logging/testing.js";
import {
  redactLogObject, scrubSecretsFromText, isSecretKey, REDACTED,
} from "./logging/redaction.js";
import { withContext, withAddedContext, currentContext } from "./observability/context.js";
import {
  createInMemoryMetrics, normalizeRoute, statusFamily, noopMetrics,
  METRIC_LABELS, METRIC_NAMES,
} from "./observability/metrics.js";
import { observeOperation } from "./observability/observe.js";
import { ResourceNotFoundError, ApplicationError } from "@lagda/application";

const config = (over: Partial<NodeJS.ProcessEnv> = {}): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "debug", ...over });

const deps = (reachable = true): AppDependencies => ({
  databaseHealth: { isReachable: () => Promise.resolve(reachable) },
});

// Synthetic markers. Long and unmistakable so a partial match still fails.
const SECRETS = {
  password: "super-secret-password-A1B2C3",
  otp: "otp-123456-D4E5F6",
  cookie: "session-secret-G7H8I9",
  signingToken: "signing-token-secret-J1K2L3",
  apiKey: "sk_live_M4N5O6_must_never_appear",
  pdf: "%PDF-1.7-SYNTHETIC-DOCUMENT-BODY-P7Q8R9",
} as const;

function assertNoSecrets(raw: string): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(raw, `secret "${name}" leaked into logs`).not.toContain(value);
  }
}

// ── The redactor ────────────────────────────────────────────────────────────

describe("deep redaction", () => {
  it("redacts a TOP-LEVEL secret key", () => {
    // Pino's `*.password` path does NOT match this. A probe found it getting
    // through the BACKEND-11 configuration.
    const out = redactLogObject({ password: SECRETS.password });
    expect(out["password"]).toBe(REDACTED);
  });

  it("redacts a secret nested arbitrarily deep", () => {
    // `*.token` matches exactly one level. This is four.
    const out = redactLogObject({ a: { b: { c: { token: SECRETS.signingToken } } } });
    expect(JSON.stringify(out)).not.toContain(SECRETS.signingToken);
  });

  it("redacts secrets inside arrays of objects", () => {
    const out = redactLogObject({
      recipients: [{ id: "rcp_1", otp: SECRETS.otp }, { id: "rcp_2", otp: SECRETS.otp }],
    });
    expect(JSON.stringify(out)).not.toContain(SECRETS.otp);
    // The non-secret sibling survives — redaction must not blank the record.
    expect(JSON.stringify(out)).toContain("rcp_1");
  });

  it("matches key names regardless of case and separators", () => {
    for (const key of ["Set-Cookie", "set_cookie", "setCookie", "SETCOOKIE"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("matches by suffix, so a new secret field is covered by default", () => {
    for (const key of ["webhookSigningSecret", "stripeApiKey", "signingAccessToken"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does NOT over-match ordinary diagnostic fields", () => {
    // Over-broad redaction destroys the logs it was meant to protect. `code` in
    // particular must stay — it is the error code every alert depends on.
    for (const key of ["code", "errorCode", "sealScheme", "pageCount", "sortKey",
                       "routeKey", "statusCode", "durationMs", "tokenCount"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it("strips credentials from a connection string in free text", () => {
    // The case field-based redaction cannot reach: a secret inside a MESSAGE.
    const scrubbed = scrubSecretsFromText(
      "connect failed for postgres://lagda:hunter2@10.0.0.5:5432/lagda",
    );
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("10.0.0.5");
  });

  it("strips signature and token query parameters from URLs", () => {
    const scrubbed = scrubSecretsFromText(
      "GET https://s3.example/doc.pdf?X-Amz-Signature=abc123SECRET&expires=60",
    );
    expect(scrubbed).not.toContain("abc123SECRET");
  });

  it("replaces binary content with a size marker", () => {
    // A PDF must never be serialized, even accidentally.
    const bytes = new TextEncoder().encode(SECRETS.pdf);
    const out = redactLogObject({ document: bytes });
    expect(JSON.stringify(out)).not.toContain("PDF-1.7-SYNTHETIC");
    expect(String(out["document"])).toMatch(/^\[binary \d+ bytes\]$/);
  });

  it("truncates a very long string rather than emitting it whole", () => {
    const out = redactLogObject({ note: "x".repeat(10_000) });
    expect(String(out["note"]).length).toBeLessThan(3_000);
  });

  it("survives a circular object instead of hanging", () => {
    // Node objects reference each other routinely. Without cycle detection the
    // formatter recurses forever and the process dies inside the logger.
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => redactLogObject({ a })).not.toThrow();
  });

  it("does not report a repeated SIBLING as circular", () => {
    const shared = { id: "x" };
    const out = redactLogObject({ first: shared, second: shared });
    expect(JSON.stringify(out["second"])).toContain("x");
  });

  it("scrubs an error message and preserves the stack", () => {
    const error = new Error(`db failure postgres://u:${SECRETS.password}@h/db`);
    const out = JSON.stringify(redactLogObject({ err: error }));
    expect(out).not.toContain(SECRETS.password);
    expect(out).toContain("db failure");
  });

  it("walks an error cause chain", () => {
    const root = new Error(`root postgres://u:${SECRETS.password}@h/db`);
    const wrapper = new Error("wrapper", { cause: root });
    expect(JSON.stringify(redactLogObject({ err: wrapper }))).not.toContain(SECRETS.password);
  });
});

// ── Through the real logger ─────────────────────────────────────────────────

describe("the configured logger", () => {
  let capture: LogCapture;
  let logger: pino.Logger;

  beforeEach(() => {
    capture = createLogCapture();
    logger = pino(
      { ...buildLoggerOptions(config()), level: "debug" } as pino.LoggerOptions,
      capture.stream,
    );
  });

  it("emits structured JSON with the service and process role", () => {
    logger.info({ event: "api.started" }, "started");
    const [line] = capture.lines();
    expect(line?.["service"]).toBe("lagda-backend");
    expect(line?.["processRole"]).toBe("api");
    expect(line?.["environment"]).toBe("test");
  });

  it("emits no secret from any nesting depth", () => {
    logger.info({ password: SECRETS.password }, "a");
    logger.info({ ctx: { otp: SECRETS.otp } }, "b");
    logger.info({ a: { b: { c: { signingToken: SECRETS.signingToken } } } }, "c");
    logger.info({ headers: { cookie: `sid=${SECRETS.cookie}` } }, "d");
    logger.info({ config: { apiKey: SECRETS.apiKey } }, "e");
    logger.info({ err: new Error(`boom postgres://u:${SECRETS.password}@h/db`) }, "f");

    assertNoSecrets(capture.raw());
  });

  it("keeps useful diagnostic fields", () => {
    logger.error({ errorCode: "not_found", durationMs: 12, dependency: "database" }, "x");
    const [line] = capture.lines();
    expect(line?.["errorCode"]).toBe("not_found");
    expect(line?.["durationMs"]).toBe(12);
  });

  it("stamps ambient context onto every line", () => {
    withContext({ requestId: "req_abc" as never, workspaceId: "ws_1" }, () => {
      logger.info({}, "inside");
    });
    const [line] = capture.lines();
    expect(line?.["requestId"]).toBe("req_abc");
    expect(line?.["workspaceId"]).toBe("ws_1");
  });
});

// ── Context isolation ───────────────────────────────────────────────────────

describe("observability context", () => {
  it("is empty outside any tracked execution", () => {
    expect(currentContext()).toEqual({});
  });

  it("propagates through nested async work", async () => {
    const seen = await withContext({ requestId: "req_1" as never }, async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 1));
      return currentContext().requestId;
    });
    expect(seen).toBe("req_1");
  });

  it("does NOT leak between concurrent executions", async () => {
    // The failure a shared mutable context object produces, and the reason this
    // is AsyncLocalStorage rather than a module-level variable.
    const run = async (id: string, delay: number): Promise<string | undefined> =>
      withContext({ requestId: id as never }, async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return currentContext().requestId;
      });

    const [a, b, c] = await Promise.all([run("req_a", 5), run("req_b", 1), run("req_c", 3)]);
    expect([a, b, c]).toEqual(["req_a", "req_b", "req_c"]);
  });

  it("does not leak after the execution completes", async () => {
    await withContext({ requestId: "req_gone" as never }, () => Promise.resolve());
    expect(currentContext().requestId).toBeUndefined();
  });

  it("enriches without mutating the parent", () => {
    withContext({ requestId: "req_1" as never }, () => {
      withAddedContext({ workspaceId: "ws_1" }, () => {
        expect(currentContext().workspaceId).toBe("ws_1");
        expect(currentContext().requestId).toBe("req_1");
      });
      // The addition does not escape upward.
      expect(currentContext().workspaceId).toBeUndefined();
    });
  });

  it("preserves context across a thrown error", async () => {
    await expect(
      withContext({ requestId: "req_err" as never }, async () => {
        await Promise.resolve();
        expect(currentContext().requestId).toBe("req_err");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

// ── Operation observation ───────────────────────────────────────────────────

describe("observeOperation", () => {
  const silentLogger = {
    debug: () => undefined, info: () => undefined,
    warn: () => undefined, error: () => undefined,
  };

  it("returns the original result unchanged", async () => {
    const result = await observeOperation(
      { operation: "Probe", logger: silentLogger, metrics: noopMetrics,
        durationMetric: "application_use_case_duration_ms",
        errorMetric: "application_errors_total" },
      () => Promise.resolve({ value: 42 }),
    );
    expect(result).toEqual({ value: 42 });
  });

  it("RETHROWS the original error, unchanged", async () => {
    // The rule that matters most here. A wrapper that swallows a failure to log
    // it has converted an outage into a silent wrong answer.
    const original = new ResourceNotFoundError("Workspace not found.");
    await expect(
      observeOperation(
        { operation: "Probe", logger: silentLogger, metrics: noopMetrics,
          durationMetric: "application_use_case_duration_ms",
          errorMetric: "application_errors_total" },
        () => Promise.reject(original),
      ),
    ).rejects.toBe(original);
  });

  it("records duration and result for a success", async () => {
    const metrics = createInMemoryMetrics();
    await observeOperation(
      { operation: "Probe", logger: silentLogger, metrics,
        durationMetric: "application_use_case_duration_ms",
        errorMetric: "application_errors_total", labels: { useCase: "Probe" } },
      () => Promise.resolve(1),
    );
    const [sample] = metrics.samples;
    expect(sample?.name).toBe("application_use_case_duration_ms");
    expect(sample?.labels["result"]).toBe("success");
    expect(sample?.value).toBeGreaterThanOrEqual(0);
  });

  it("labels a failure by CATEGORY, never by message", async () => {
    const metrics = createInMemoryMetrics();
    await observeOperation(
      { operation: "Probe", logger: silentLogger, metrics,
        durationMetric: "application_use_case_duration_ms",
        errorMetric: "application_errors_total" },
      () => Promise.reject(new ResourceNotFoundError("Workspace ws_secret not found.")),
    ).catch(() => undefined);

    const errorSample = metrics.samples.find(s => s.name === "application_errors_total");
    expect(errorSample?.labels["errorCategory"]).toBe("not-found");
    // The message must not become a label — unbounded cardinality, and it names
    // a resource.
    expect(JSON.stringify(errorSample?.labels)).not.toContain("ws_secret");
  });

  it("logs an internal failure at error and a client failure at info", async () => {
    const levels: string[] = [];
    const logger = {
      debug: () => levels.push("debug"), info: () => levels.push("info"),
      warn: () => levels.push("warn"), error: () => levels.push("error"),
    };
    const base = { operation: "Probe", logger, metrics: noopMetrics,
      durationMetric: "application_use_case_duration_ms" as const,
      errorMetric: "application_errors_total" as const };

    await observeOperation(base, () => Promise.reject(new ResourceNotFoundError("x"))).catch(() => undefined);
    await observeOperation(base, () => Promise.reject(new Error("unexpected"))).catch(() => undefined);

    // A mistyped ID is not a production incident; an unexpected throw is.
    expect(levels).toEqual(["info", "error"]);
  });

  it("does not log a successful operation at info", async () => {
    // One info line per successful use case is volume without information once
    // metrics exist.
    const levels: string[] = [];
    await observeOperation(
      { operation: "Probe",
        logger: { debug: () => levels.push("debug"), info: () => levels.push("info"),
                  warn: () => levels.push("warn"), error: () => levels.push("error") },
        metrics: noopMetrics,
        durationMetric: "application_use_case_duration_ms",
        errorMetric: "application_errors_total" },
      () => Promise.resolve(1),
    );
    expect(levels).toEqual(["debug"]);
  });

  it("makes the operation name available to the ambient context", async () => {
    let seen: string | undefined;
    await observeOperation(
      { operation: "SubmitSignature", logger: silentLogger, metrics: noopMetrics,
        durationMetric: "application_use_case_duration_ms",
        errorMetric: "application_errors_total" },
      () => { seen = currentContext().operation; return Promise.resolve(1); },
    );
    expect(seen).toBe("SubmitSignature");
  });
});

// ── Metric cardinality ──────────────────────────────────────────────────────

describe("metric catalog", () => {
  const FORBIDDEN = [
    "requestId", "workspaceId", "userId", "documentId",
    "signingRequestId", "verificationId", "email", "ipAddress", "recipientId",
  ];

  it("declares no unbounded identifier as a label", () => {
    // The audit that keeps a time-series database alive. One series per tenant
    // per resource is the textbook cardinality explosion.
    for (const [metric, labels] of Object.entries(METRIC_LABELS)) {
      for (const forbidden of FORBIDDEN) {
        expect(labels as readonly string[], `${metric} labels ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("declares labels for every metric name", () => {
    for (const name of METRIC_NAMES) {
      expect(Object.keys(METRIC_LABELS)).toContain(name);
    }
  });

  it("normalizes a raw URL containing identifiers", () => {
    expect(normalizeRoute(undefined, "/documents/doc_A1B2C3D4/fields"))
      .toBe("/documents/:id/fields");
    expect(normalizeRoute("/documents/:documentId", "/documents/doc_x"))
      .toBe("/documents/:documentId");
  });

  it("collapses status codes to three families", () => {
    expect([200, 204, 404, 422, 500, 503].map(statusFamily))
      .toEqual(["2xx", "2xx", "4xx", "4xx", "5xx", "5xx"]);
  });
});

// ── The API, end to end ─────────────────────────────────────────────────────

describe("request logging", () => {
  let app: FastifyInstance;
  let capture: LogCapture;

  beforeEach(() => { capture = createLogCapture(); });
  afterEach(async () => { await app?.close(); });

  async function build(): Promise<FastifyInstance> {
    const built = Fastify({
      logger: { ...buildLoggerOptions(config()), level: "debug", stream: capture.stream },
      genReqId: () => "req_fixed_for_test",
    });
    built.post("/probe", {
      schema: { body: Type.Object({ note: Type.String() }, { additionalProperties: false }) },
    }, (_request, reply) => { void reply.send({ ok: true }); });
    built.get("/probe/boom", {}, () => {
      throw new Error(`failure postgres://lagda:${SECRETS.password}@10.0.0.5/db`);
    });
    await built.ready();
    return built;
  }

  it("logs method, route and status without body or headers", async () => {
    app = await build();
    await app.inject({
      method: "POST", url: "/probe?token=SHOULD_NOT_APPEAR",
      headers: { cookie: `sid=${SECRETS.cookie}`, authorization: "Bearer SECRET_AUTH" },
      payload: { note: SECRETS.password },
    });

    const raw = capture.raw();
    expect(raw).toContain("/probe");
    expect(raw).not.toContain("SHOULD_NOT_APPEAR");
    expect(raw).not.toContain("SECRET_AUTH");
    assertNoSecrets(raw);
  });

  it("logs an unexpected failure with a scrubbed message", async () => {
    app = await build();
    await app.inject({ method: "GET", url: "/probe/boom" });

    const raw = capture.raw();
    // Operationally visible…
    expect(raw).toContain("failure postgres");
    // …without the credential.
    expect(raw).not.toContain(SECRETS.password);
  });

  it("carries the request id on every line for that request", async () => {
    app = await build();
    await app.inject({ method: "GET", url: "/probe/boom" });

    const withReq = capture.lines().filter(l => l["reqId"] !== undefined
      || l["requestId"] !== undefined);
    expect(withReq.length).toBeGreaterThan(0);
  });
});

describe("the full app", () => {
  it("keeps the request id out of metric labels", async () => {
    const metrics = createInMemoryMetrics();
    const app = await createApp({ config: config(), dependencies: deps(), metrics });
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    const sample = metrics.samples.find(s => s.name === "http_requests_total");
    expect(sample?.labels).toEqual({
      method: "GET", route: "/health", statusFamily: "2xx", processRole: "api",
    });
    expect(JSON.stringify(metrics.samples)).not.toContain("req_");
  });

  it("records a duration for each request", async () => {
    const metrics = createInMemoryMetrics();
    const app = await createApp({ config: config(), dependencies: deps(), metrics });
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    const duration = metrics.samples.find(s => s.name === "http_request_duration_ms");
    expect(duration?.value).toBeGreaterThanOrEqual(0);
  });

  it("counts a 5xx as an http error", async () => {
    const metrics = createInMemoryMetrics();
    const app = await createApp({ config: config(), dependencies: deps(), metrics });
    app.get("/probe/boom", {}, () => { throw new Error("boom"); });
    await app.inject({ method: "GET", url: "/probe/boom" });
    await app.close();

    expect(metrics.samples.some(s => s.name === "http_errors_total")).toBe(true);
  });

  it("still returns a sanitized body while logging the detail", async () => {
    // BACKEND-11's guarantee, re-asserted here because observability is exactly
    // where it would be eroded.
    const app = await createApp({ config: config(), dependencies: deps() });
    app.get("/probe/boom", {}, () => {
      throw new Error(`postgres://u:${SECRETS.password}@h/db`);
    });
    const response = await app.inject({ method: "GET", url: "/probe/boom" });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(SECRETS.password);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("internal_error");
  });
});

describe("application errors stay provider independent", () => {
  it("carries no logger or metrics reference", () => {
    // If an ApplicationError ever gained a logger, `@lagda/application` would
    // have acquired an observability dependency by the back door.
    const error: ApplicationError = new ResourceNotFoundError("x");
    expect(Object.keys(error)).not.toContain("logger");
    expect(Object.keys(error)).not.toContain("metrics");
  });
});
