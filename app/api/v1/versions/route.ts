import { withApiV1 } from "@/lib/api-platform/handler"
import { jsonOk } from "@/lib/api-platform/response"
import {
  API_VERSIONS,
  COMPATIBILITY_POLICY,
  DEFAULT_API_VERSION,
  LATEST_API_VERSION,
} from "@/lib/api-platform/versioning"

/**
 * Publishes the explicit, machine-readable version contracts and the
 * v1 → v2 compatibility / migration policy. Any authenticated key may read it
 * (no extra scope) so integrators can discover which versions exist, which is
 * the default, and exactly what changed between them. The response itself is
 * version-negotiated like every other endpoint (see `ctx.apiVersion`).
 */
export const GET = withApiV1({ rateLimit: false }, async (ctx) => {
  return jsonOk(
    {
      default_version: DEFAULT_API_VERSION,
      latest_version: LATEST_API_VERSION,
      requested_version: ctx.apiVersion,
      versions: API_VERSIONS,
      compatibility_policy: COMPATIBILITY_POLICY,
    },
    { requestId: ctx.requestId },
  )
})
