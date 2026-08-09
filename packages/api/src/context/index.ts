// Server-observed request metadata.
//
// BACKEND-10 built evidence tables with `client_ip` and `client_user_agent`
// columns and deliberately left them unwritten, because writing them before
// proxy trust was configured would have recorded attacker-supplied text as
// signing evidence. This is the type that will eventually fill them — and the
// provenance rules that make that safe.
//
// THE RULE: every field here comes from the server's view of the connection or
// from a header the server treats as untrusted-but-observed. NOTHING here may
// ever be read from a request body. A client that can name its own IP address
// is describing itself, not being observed.

import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { RequestId } from "@lagda/contracts";
import type { TrustProxySetting } from "../config/index.js";

/**
 * How much an observed IP can be believed.
 *
 * Carried alongside the value rather than inferred later, because by the time a
 * use case has the address it has no way to know whether a proxy was trusted.
 * An evidence writer can then refuse to persist an address it cannot stand
 * behind, instead of silently recording one.
 */
export type IpProvenance =
  /** The socket's remote address. Trustworthy, but it is the proxy's address if one exists. */
  | "socket"
  /** Derived from forwarded headers under an explicit trusted-proxy configuration. */
  | "trusted-proxy"
  /** No address could be determined. */
  | "unavailable";

export interface ObservedIpAddress {
  readonly value: string | null;
  readonly provenance: IpProvenance;
}

export interface ObservedRequestMetadata {
  readonly requestId: RequestId;
  readonly ip: ObservedIpAddress;
  /**
   * Untrusted client-supplied text, bounded. Never parsed into a claimed device
   * identity — a user-agent string is a self-report, and calling it a verified
   * device would overstate what it proves.
   */
  readonly userAgent: string | null;
}

/** Bounded before it can reach a log line or a database column. */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * Generates a request ID.
 *
 * `randomUUID` from `node:crypto`, not `Math.random()`. The value appears in
 * logs and in error bodies handed to users, and a predictable ID invites
 * guessing at other requests' correlation data.
 *
 * Opaque by construction: it encodes no user, workspace or business timestamp,
 * so it cannot become a covert channel for identifiers that belong in the body.
 */
export function generateRequestId(): RequestId {
  return `req_${randomUUID().replace(/-/g, "")}` as RequestId;
}

/**
 * Resolves the client IP with explicit provenance.
 *
 * When proxy trust is `none`, Fastify has not parsed `X-Forwarded-For` at all
 * and `request.ip` is the socket address — so a spoofed header simply has no
 * effect. That is the safe default and the reason the default is `none`.
 *
 * When proxy trust IS configured, Fastify resolves the header according to that
 * configuration, and only then is the result marked `trusted-proxy`.
 */
export function observeIp(
  request: FastifyRequest,
  trustProxy: TrustProxySetting,
): ObservedIpAddress {
  const value = request.ip;
  if (typeof value !== "string" || value === "") {
    return { value: null, provenance: "unavailable" };
  }
  return {
    value,
    provenance: trustProxy.mode === "none" ? "socket" : "trusted-proxy",
  };
}

export function observeUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers["user-agent"];
  if (typeof raw !== "string" || raw === "") return null;
  return raw.slice(0, MAX_USER_AGENT_LENGTH);
}

export function observeRequest(
  request: FastifyRequest,
  trustProxy: TrustProxySetting,
): ObservedRequestMetadata {
  return {
    requestId: request.id as RequestId,
    ip: observeIp(request, trustProxy),
    userAgent: observeUserAgent(request),
  };
}
