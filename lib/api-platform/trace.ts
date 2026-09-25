import "server-only"
/**
 * Request trace context for the public API.
 * ---------------------------------------------------------------------------
 * Every `/api/v1/*` request is correlatable by stable fields:
 *
 *   - `request_id` — the `req_...` id generated per request (also `X-Request-Id`).
 *                    Always server-generated; never taken from the client.
 *   - `trace_id`   — W3C Trace Context id. Adopted from an inbound valid
 *                    `traceparent` header so the caller's distributed trace
 *                    continues through us; otherwise generated. Echoed back in
 *                    a `traceparent` response header with a fresh span id.
 *   - `tenant_id`  — the owning tenant of the authenticated principal.
 *   - `actor_id`   — WHO acted, as a namespaced principal string:
 *                      `apikey:<id>`  for a raw API key,
 *                      `oauth:<id>`   for an OAuth client-credentials token.
 *
 * These travel together onto structured logs (api_request_audit), onto the
 * error envelope, and onto response headers.
 */
import crypto from "crypto"
import type { ApiKeyAuth } from "@/lib/api-auth"

export type TraceContext = {
  requestId: string
  traceId: string
  tenantId: number | null
  actorId: string | null
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/**
 * Parses a W3C `traceparent`. Returns the trace id, or null when absent,
 * malformed, version `ff`, or all-zero ids (all invalid per the spec).
 */
export function parseTraceparent(header: string | null | undefined): string | null {
  if (!header) return null
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase())
  if (!m) return null
  const [, version, traceId, parentId] = m
  if (version === "ff") return null
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null
  return traceId
}

export function newTraceId(): string {
  return crypto.randomBytes(16).toString("hex")
}

/** Builds the outbound `traceparent` for this hop (new span, sampled). */
export function formatTraceparent(traceId: string): string {
  return `00-${traceId}-${crypto.randomBytes(8).toString("hex")}-01`
}

/**
 * Derives the namespaced actor id from an authenticated principal. The kind is
 * taken from the presence of `auth.oauth` (see lib/api-auth.ts), never from
 * client input, so it cannot be spoofed.
 */
export function actorFromAuth(auth: ApiKeyAuth | null | undefined): string | null {
  if (!auth) return null
  return auth.oauth ? `oauth:${auth.keyId}` : `apikey:${auth.keyId}`
}

/** Assembles the trace context. Tenant/actor may be null before authentication. */
export function buildTrace(
  requestId: string,
  traceId: string,
  auth: ApiKeyAuth | null | undefined,
  tenantId: number | null,
): TraceContext {
  return { requestId, traceId, tenantId, actorId: actorFromAuth(auth) }
}
