/**
 * Spec28 (#125) — Request-level maintenance gate used by middleware.
 * Edge-safe: no DB access. Live windows come from the token-protected internal
 * feed (cached per isolate); bypass claims in the JWT are re-verified against
 * the DB via /api/maintenance before any bypass is honored.
 *
 * Failure policy: if the window feed is unreachable the gate fails OPEN (a
 * lookup failure must never lock every tenant out); the workspace layout still
 * enforces tenant/platform windows server-side as a second layer. If a bypass
 * cannot be verified, the request is BLOCKED (fail closed for privilege).
 */
import { NextResponse, type NextRequest } from "next/server"
import {
  type BypassHint,
  type MaintenanceWindow,
  gateDecision,
  isMaintenanceExemptPath,
  moduleKeyForPath,
  retryAfterSeconds,
  userMessage,
} from "@/lib/maintenance/model"
import { GATE_HEADER, maintenanceGateToken } from "@/lib/maintenance/gate-token"

const WINDOWS_TTL_MS = 15_000
const BYPASS_TTL_MS = 15_000
let windowsCache: { at: number; windows: MaintenanceWindow[] } | null = null
const bypassCache = new Map<string, { at: number; ok: boolean }>()

type Fetcher = typeof fetch

export function __resetEdgeGateCache(): void {
  windowsCache = null
  bypassCache.clear()
}

async function loadWindows(origin: string, doFetch: Fetcher): Promise<MaintenanceWindow[] | null> {
  if (windowsCache && Date.now() - windowsCache.at < WINDOWS_TTL_MS) return windowsCache.windows
  try {
    const token = await maintenanceGateToken(process.env.SESSION_SECRET)
    if (!token) return windowsCache?.windows ?? null
    const res = await doFetch(`${origin}/api/maintenance/live`, { headers: { [GATE_HEADER]: token }, cache: "no-store" })
    if (!res.ok) return windowsCache?.windows ?? null
    const body = (await res.json()) as { windows?: MaintenanceWindow[] }
    windowsCache = { at: Date.now(), windows: Array.isArray(body.windows) ? body.windows : [] }
    return windowsCache.windows
  } catch {
    return windowsCache?.windows ?? null
  }
}

async function verifyBypass(request: NextRequest, cacheKey: string, moduleKey: string | null, doFetch: Fetcher): Promise<boolean> {
  const hit = bypassCache.get(cacheKey)
  if (hit && Date.now() - hit.at < BYPASS_TTL_MS) return hit.ok
  let ok = false
  try {
    const url = new URL("/api/maintenance", request.nextUrl.origin)
    if (moduleKey) url.searchParams.set("module", moduleKey)
    const res = await doFetch(url, { headers: { cookie: request.headers.get("cookie") ?? "" }, cache: "no-store" })
    if (res.ok) ok = ((await res.json()) as { blocked?: boolean }).blocked === false
  } catch {
    ok = false
  }
  if (bypassCache.size > 5000) bypassCache.clear()
  bypassCache.set(cacheKey, { at: Date.now(), ok })
  return ok
}

export function blockedResponse(request: NextRequest, window: MaintenanceWindow, requestId: string): NextResponse {
  const { pathname } = request.nextUrl
  const retryAfter = retryAfterSeconds(window)
  if (pathname.startsWith("/api")) {
    const headers: Record<string, string> = { "Cache-Control": "no-store", "x-request-id": requestId }
    if (retryAfter != null) headers["Retry-After"] = String(retryAfter)
    return NextResponse.json(
      {
        error: userMessage(window),
        code: "MAINTENANCE",
        requestId,
        maintenance: { scope: window.scope, moduleKey: window.moduleKey, title: window.title, endsAt: window.endsAt },
      },
      { status: 503, headers },
    )
  }
  const headers = new Headers(request.headers)
  headers.set("x-maintenance-path", pathname)
  headers.set("x-request-id", requestId)
  const res = NextResponse.rewrite(new URL("/maintenance", request.url), { request: { headers } })
  res.headers.set("x-request-id", requestId)
  res.headers.set("Cache-Control", "no-store")
  return res
}

export type GateSubject = {
  tenantId: number | null
  /** Stable key for caching the bypass verdict (e.g. user + tenant). */
  cacheKey: string
  /** Role claims from the verified JWT; null for users who can never bypass (portals). */
  hint: BypassHint | null
}

/** Returns a blocking response, or null to let the request continue. */
export async function maintenanceGate(
  request: NextRequest,
  subject: GateSubject,
  requestId: string,
  doFetch: Fetcher = fetch,
): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl
  if (isMaintenanceExemptPath(pathname)) return null
  const windows = await loadWindows(request.nextUrl.origin, doFetch)
  if (!windows || windows.length === 0) return null
  const moduleKey = moduleKeyForPath(pathname)
  const decision = gateDecision(windows, { tenantId: subject.tenantId, moduleKey }, subject.hint)
  if (decision.action === "allow") return null
  if (decision.action === "verify") {
    const ok = await verifyBypass(request, `${subject.cacheKey}|${moduleKey ?? ""}|${decision.window.id}`, moduleKey, doFetch)
    if (ok) return null
  }
  return blockedResponse(request, decision.window, requestId)
}
