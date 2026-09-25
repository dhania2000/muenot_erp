import "server-only"
/**
 * Request trace context for the public API.
 * ---------------------------------------------------------------------------
 * Every `/api/v1/*` request is correlatable by three stable fields:
 *
 *   - `request_id` — the `req_...` id generated per request (also `X-Request-Id`).
 *   - `tenant_id`  — the owning tenant of the authenticated principal.
 *   - `actor_id`   — WHO acted, as a namespaced principal string:
 *                      `apikey:<id>`  for a raw API key,
 *                      `oauth:<id>`   for an OAuth client-credentials token.
 *
 * These three travel together onto structured logs (api_request_audit), onto
 * the error envelope, and onto response headers, so a single line in a client's
 * error report is enough to find the exact server-side record.
 */
import type { ApiKeyAuth } from "@/lib/api-auth"

export type TraceContext = {
  requestId: string
  tenantId: number | null
  actorId: string | null
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

/** Assembles the trace triple. Any field may be null before authentication. */
export function buildTrace(
  requestId: string,
  auth: ApiKeyAuth | null | undefined,
  tenantId: number | null,
): TraceContext {
  return { requestId, tenantId, actorId: actorFromAuth(auth) }
}
