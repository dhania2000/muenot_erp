import "server-only"
/**
 * The shared public-API request pipeline.
 * ---------------------------------------------------------------------------
 * `withApiV1` wraps a route handler so that EVERY `/api/v1/*` endpoint gets the
 * same cross-cutting behavior, in a fixed order, without re-implementing it:
 *
 *   1. Request ID        — generate `req_...`, echoed on every response + logs.
 *   2. Version pin       — honor `X-API-Version`; reject unknown versions.
 *   3. Authentication    — Bearer API key (lib/api-auth.ts), fail-closed.
 * 4. IP restrictions — per-key CIDR allowlist.
 *   5. Environment gate  — optionally require a live/test key.
 *   6. Authorization     — required scopes must all be granted.
 *   7. Rate limiting     — per-key fixed window; sets X-RateLimit-* headers.
 *   8. Idempotency       — replay stored responses for repeated Idempotency-Key.
 *   9. Handler           — the route's own logic, given a typed context.
 *  10. Error standard    — ApiError → standard envelope; unknown → 500.
 *  11. Audit logging     — record method, path, status, latency (best-effort).
 *
 * A route handler just does its job and throws `ApiError` for failures; it
 * never touches auth, headers, or error shapes directly.
 */
import crypto from "crypto"
import { NextResponse } from "next/server"
import { authenticateApiKeyResult, hasScope, type ApiKeyAuth } from "@/lib/api-auth"
import { keyAllowsIp, recordApiKeyEvent, type ApiKeyEnvironment } from "@/lib/api-keys-store"
import { getClientIp } from "@/lib/rate-limit"
import {
  applyEndpointOverride,
  resolveTierForPlan,
  type RateLimitTier,
} from "@/lib/api-platform/rate-limit-engine"
import { enforceSharedRateLimits, type RateBudget } from "@/lib/api-platform/rate-limit-store"
import { applicableRateBudgets } from "@/lib/api-platform/rate-limit-policies"
import { getTenantById } from "@/lib/tenant-service"
import { createCache } from "@/lib/cache"
import { ApiError, isApiError } from "@/lib/api-platform/errors"
import { API_VERSION, jsonError, jsonErrorFromApiError, type ErrorTrace } from "@/lib/api-platform/response"
import { resolveApiVersion, type ApiVersion } from "@/lib/api-platform/versioning"
import { actorFromAuth } from "@/lib/api-platform/trace"
import { logApiRequest } from "@/lib/api-platform/audit"
import { fingerprintRequest, lookupIdempotency, saveIdempotency } from "@/lib/api-platform/idempotency"
import { enforceUsageIfScoped, meterUsage, UsageLimitError } from "@/lib/billing/usage-guard"

export type ApiRequestContext<P = Record<string, string>> = {
  request: Request
  url: URL
  params: P
  requestId: string
  auth: ApiKeyAuth
  clientIp: string | null
  /** The effective API version negotiated from `X-API-Version` (or the default). */
  apiVersion: ApiVersion
  /** Namespaced actor id (`apikey:<id>` / `oauth:<id>`) for handler-side logging. */
  actorId: string | null
  /** Parsed JSON body for mutating methods, or null. Throws ApiError on invalid JSON. */
  json: <T = any>() => Promise<T>
}

export type ApiV1Options = {
  /** Required scope(s). All listed scopes must be granted on the key. */
  scopes?: string | string[]
  /**
   * Rate limiting for this endpoint. Limits are resolved from the
   * caller's plan tier; pass a partial override here to make an expensive
   * endpoint stricter (each provided window caps at min(plan, override)).
   * Pass `false` to disable rate limiting for this endpoint entirely.
   */
  rateLimit?: Partial<RateLimitTier> | false
  /**
   * Idempotency-Key handling (only meaningful for mutating methods):
   *   - `true`       → honor Idempotency-Key when present (replay / conflict).
   *   - `"required"` → additionally REJECT mutating requests that omit the
   *     header with `idempotency_key_required` (400). Use for create and
   *     payment mutations where an accidental retry must never double-write.
   */
  idempotency?: boolean | "required"
  /** Require the key to belong to a specific environment. */
  requireEnvironment?: ApiKeyEnvironment
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Plan-tier lookups hit the tenants table, so cache the resolved tier briefly
 * to keep the rate-limit check off the DB on the hot path. The shared TTL cache
 * bounds memory under many tenants and single-flights concurrent
 * misses so a cold cache under load does not stampede the tenants table.
 */
const TIER_CACHE_TTL_MS = 60_000
const tierCache = createCache<RateLimitTier>("apiv1:tenant-tier", {
  maxEntries: 5_000,
  defaultTtlMs: TIER_CACHE_TTL_MS,
})

async function tierForTenant(tenantId: number): Promise<RateLimitTier> {
  return tierCache.getOrLoad(String(tenantId), async () => {
    let plan: string | null = null
    try {
      plan = (await getTenantById(tenantId))?.plan ?? null
    } catch {
      // Fall back to the default tier if the tenant lookup fails.
    }
    return resolveTierForPlan(plan)
  })
}

function newRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`
}

function applyStandardHeaders(res: NextResponse, requestId: string, version: string): NextResponse {
  res.headers.set("X-Request-Id", requestId)
  // Echo the EFFECTIVE negotiated version so callers can assert the contract.
  res.headers.set("X-API-Version", version)
  return res
}

export function withApiV1<P = Record<string, string>>(
  options: ApiV1Options,
  handler: (ctx: ApiRequestContext<P>) => Promise<NextResponse> | NextResponse,
) {
  return async function route(
    request: Request,
    routeCtx?: { params?: Promise<P> | P },
  ): Promise<NextResponse> {
    const started = Date.now()
    const requestId = newRequestId()
    const url = new URL(request.url)
    const clientIp = getClientIp(request)
    const method = request.method.toUpperCase()
    const path = url.pathname

    // Auth outcome + trace context for audit logging in every exit path.
    let auditKeyId: number | null = null
    let auditTenantId: number | null = null
    let auditActorId: string | null = null
    let auditEnv: string | null = null
    // Effective negotiated version; echoed on responses + stamped on logs.
    let effectiveVersion: ApiVersion = API_VERSION

    const finalize = (res: NextResponse, errorCode: string | null): NextResponse => {
      applyStandardHeaders(res, requestId, effectiveVersion)
      void logApiRequest({
        tenantId: auditTenantId,
        keyId: auditKeyId,
        actorId: auditActorId,
        requestId,
        method,
        path,
        status: res.status,
        errorCode,
        apiVersion: effectiveVersion,
        environment: auditEnv,
        ip: clientIp,
        durationMs: Date.now() - started,
      })
      return res
    }

    // The trace triple (request_id + tenant_id + actor_id) is stamped onto
    // every error envelope so a client error report maps to one audit row.
    const currentTrace = (): ErrorTrace => ({ tenantId: auditTenantId, actorId: auditActorId })

    const fail = (err: ApiError, extraHeaders?: Record<string, string>): NextResponse =>
      finalize(jsonErrorFromApiError(err, requestId, extraHeaders, currentTrace()), err.code)

    try {
      // 2. Version negotiation (opt-in header pin).
      const negotiated = resolveApiVersion(request.headers.get("x-api-version"))
      if (!negotiated.ok) {
        return fail(
          new ApiError(
            "unsupported_version",
            `Unsupported API version "${negotiated.requested}". Current: ${API_VERSION}`,
          ),
        )
      }
      effectiveVersion = negotiated.version

      // 3. Authentication.
      const authResult = await authenticateApiKeyResult(request)
      if (!authResult.ok) {
        if (authResult.keyId != null) {
          auditKeyId = authResult.keyId
          auditTenantId = authResult.tenantId ?? null
          void recordApiKeyEvent({
            tenantId: authResult.tenantId ?? 0,
            keyId: authResult.keyId,
            event: "auth_failed",
            ip: clientIp,
            detail: authResult.reason,
          })
        }
        const message =
          authResult.reason === "revoked"
            ? "API key has been revoked"
            : authResult.reason === "expired"
              ? "API key has expired"
              : "Missing or invalid API key"
        return fail(new ApiError("unauthorized", message))
      }

      const auth = authResult.auth
      auditKeyId = auth.keyId
      auditTenantId = auth.tenantId
      auditActorId = actorFromAuth(auth)
      auditEnv = auth.environment

      // 4. IP restrictions.
      if (!keyAllowsIp(auth.ipRestrictions, clientIp)) {
        void recordApiKeyEvent({
          tenantId: auth.tenantId,
          keyId: auth.keyId,
          event: "auth_failed",
          ip: clientIp,
          detail: "ip_not_allowed",
        })
        return fail(new ApiError("ip_not_allowed", "Request IP is not in this key's allowlist"))
      }

      // 5. Environment gate.
      if (options.requireEnvironment && auth.environment !== options.requireEnvironment) {
        return fail(
          new ApiError("forbidden", `This endpoint requires a ${options.requireEnvironment} key`),
        )
      }

      // 6. Authorization (scopes).
      const requiredScopes = options.scopes
        ? Array.isArray(options.scopes)
          ? options.scopes
          : [options.scopes]
        : []
      for (const scope of requiredScopes) {
        if (!hasScope(auth, scope)) {
          return fail(new ApiError("forbidden", `Key lacks required scope "${scope}"`))
        }
      }
      // OAuth access tokens carry an offset synthetic keyId; the per-key audit
      // trail (api_key_events) is only meaningful for real API keys.
      const isApiKeyPrincipal = !auth.oauth

      // 7. Rate limiting (per key, plan-tiered, multi-window — ).
      let rateHeaders: Record<string, string> = {}
      if (options.rateLimit !== false) {
        const planTier = await tierForTenant(auth.tenantId)
        // MySQL counters are shared across workers and consumed transactionally.
        // Never fall back to in-process counters on DB failure: that would bypass
        // a production limit whenever a node loses its database connection.
        let decision
        try {
          const budgets: RateBudget[] = [{ scope: `apiv1:key:${auth.keyId}`, tier: planTier }]
          if (options.rateLimit) budgets.push({ scope: `apiv1:key:${auth.keyId}:endpoint:${path}`, tier: applyEndpointOverride(planTier, options.rateLimit) })
          budgets.push(...await applicableRateBudgets(auth.tenantId, auth.keyId, path, planTier))
          decision = await enforceSharedRateLimits(auth.tenantId, budgets)
        } catch {
          return fail(new ApiError("rate_limit_unavailable", "Rate limiting is temporarily unavailable"))
        }
        rateHeaders = decision.headers
        if (!decision.allowed) {
          if (decision.abuse && isApiKeyPrincipal) {
            void recordApiKeyEvent({
              tenantId: auth.tenantId,
              keyId: auth.keyId,
              event: "auth_failed",
              ip: clientIp,
              detail: "rate_abuse_block",
            })
          }
          const message = decision.abuse
            ? "Temporarily blocked due to excessive requests"
            : `Rate limit exceeded (${decision.window} window)`
          return fail(new ApiError("rate_limited", message), rateHeaders)
        }
      }

      // 7b. Usage quota (billable API requests). Distinct from rate limiting:
      // the rate limit protects the platform per short window; this enforces the
      // tenant's monthly plan allowance and overage. A hard limit fails closed
      // with 402; a soft limit is allowed and flagged with a warning header.
      let apiUsageLimit
      try {
        apiUsageLimit = await enforceUsageIfScoped("api_requests", 1, auth.tenantId)
      } catch (err) {
        if (err instanceof UsageLimitError) {
          return fail(new ApiError("usage_limit_reached", err.message), rateHeaders)
        }
        throw err
      }
      // Record the metered request (idempotent on the request id).
      meterUsage({
        meterKey: "api_requests",
        quantity: 1,
        source: "api_v1",
        refId: requestId,
        idempotencyKey: `api:${requestId}`,
        tenantId: auth.tenantId,
      })

      // Cache the raw body once so both idempotency and the handler can read it.
      let rawBodyCache: string | null = null
      const readRaw = async (): Promise<string> => {
        if (rawBodyCache === null) rawBodyCache = await request.text()
        return rawBodyCache
      }

      const ctx: ApiRequestContext<P> = {
        request,
        url,
        params: routeCtx?.params ? await routeCtx.params : ({} as P),
        requestId,
        auth,
        clientIp,
        apiVersion: effectiveVersion,
        actorId: auditActorId,
        json: async <T,>() => {
          const raw = await readRaw()
          if (!raw) throw new ApiError("bad_request", "Request body is required")
          try {
            return JSON.parse(raw) as T
          } catch {
            throw new ApiError("bad_request", "Invalid JSON body")
          }
        },
      }

      // 8. Idempotency (mutating methods only).
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null
      // For create/payment mutations the key is mandatory: reject a mutating
      // request that omits it rather than silently allowing a double-write.
      if (options.idempotency === "required" && MUTATING.has(method) && !idempotencyKey) {
        return fail(
          new ApiError(
            "idempotency_key_required",
            "This endpoint requires an Idempotency-Key header for safe retries",
          ),
          rateHeaders,
        )
      }
      const idempotencyEnabled = Boolean(options.idempotency) && MUTATING.has(method) && Boolean(idempotencyKey)
      let fingerprint = ""
      if (idempotencyEnabled && idempotencyKey) {
        const raw = await readRaw()
        fingerprint = fingerprintRequest(method, path, raw)
        const prior = await lookupIdempotency(auth.keyId, idempotencyKey, fingerprint)
        if (prior?.conflict) {
          return fail(
            new ApiError(
              "idempotency_conflict",
              "Idempotency-Key was already used with a different request payload",
            ),
            rateHeaders,
          )
        }
        if (prior?.record) {
          const replay = new NextResponse(prior.record.body, {
            status: prior.record.status,
            headers: { "Content-Type": "application/json", "Idempotency-Replayed": "true", ...rateHeaders },
          })
          return finalize(replay, prior.record.status >= 400 ? "replayed_error" : null)
        }
      }

      // 9. Handler.
      let res = await handler(ctx)
      for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v)
      if (apiUsageLimit && (apiUsageLimit.status === "warning" || apiUsageLimit.status === "over")) {
        res.headers.set("X-Usage-Warning", `api_requests:${apiUsageLimit.status}`)
      }

      // 8b. Persist idempotent responses (skip server errors so they can be retried).
      if (idempotencyEnabled && idempotencyKey && res.status < 500) {
        const body = await res.clone().text()
        void saveIdempotency(auth.tenantId, auth.keyId, idempotencyKey, fingerprint, res.status, body)
      }

      return finalize(res, res.status >= 400 ? "handler_error" : null)
    } catch (err) {
      if (isApiError(err)) return fail(err)
      console.log("[v0] Unhandled API error:", err instanceof Error ? err.message : String(err))
      return finalize(
        jsonError("internal_error", "An unexpected error occurred", {
          requestId,
          status: 500,
        }),
        "internal_error",
      )
    }
  }
}
