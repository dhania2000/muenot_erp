import { NextResponse, type NextRequest } from "next/server"
import { jwtVerify } from "jose"
import { maintenanceGate, type GateSubject } from "@/lib/maintenance/edge-gate"
import { isMaintenanceExemptPath } from "@/lib/maintenance/model"
import { billingWriteLockGate } from "@/lib/billing/edge-write-lock"

const SESSION_COOKIE = "ems_session"
const PORTAL_SESSION_COOKIE = "ems_portal_session"
const VENDOR_PORTAL_SESSION_COOKIE = "ems_vendor_portal_session"
const PUBLIC_PATHS = ["/login", "/api/auth/login"]
// SPEC 118 — Client Portal public entry points (external users).
const PORTAL_PUBLIC_PATHS = ["/portal/login", "/api/portal/auth/login", "/api/portal/auth/logout"]
// SPEC 119 — Vendor Portal public entry points (external users).
const VENDOR_PORTAL_PUBLIC_PATHS = [
  "/vendor-portal/login",
  "/api/vendor-portal/auth/login",
  "/api/vendor-portal/auth/logout",
]

function getSecretKey() {
  return new TextEncoder().encode(process.env.SESSION_SECRET || "")
}

// Portal tokens are domain-separated from internal tokens (see lib/portal/auth.ts).
function getPortalSecretKey() {
  return new TextEncoder().encode(`${process.env.SESSION_SECRET || ""}:portal`)
}

// Vendor-portal tokens use their own domain-separated key (see lib/vendor-portal/auth.ts).
function getVendorPortalSecretKey() {
  return new TextEncoder().encode(`${process.env.SESSION_SECRET || ""}:vendor-portal`)
}

type EdgeSession = {
  userId: number
  role: "admin" | "employee"
  tenantId?: number
  activeTenantId?: number | null
  impersonatedTenantId?: number | null
  platformRole?: string
  tenantRole?: string
}

async function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    return payload as EdgeSession
  } catch {
    return null
  }
}

// Spec28 — the tenant used for maintenance scoping mirrors getSession(): an
// entered tenant (impersonation) or switched org wins over the home tenant.
function maintenanceSubject(s: EdgeSession): GateSubject {
  const tenantId = s.impersonatedTenantId ?? s.activeTenantId ?? s.tenantId ?? null
  return {
    tenantId,
    cacheKey: `u:${s.userId}|t:${tenantId ?? ""}`,
    hint: { platformRole: s.platformRole ?? null, tenantRole: s.tenantRole ?? null },
  }
}

function writeLockSubject(s: EdgeSession) {
  return {
    tenantId: s.impersonatedTenantId ?? s.activeTenantId ?? s.tenantId ?? null,
    platformRole: s.platformRole ?? null,
  }
}

async function getPortalSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(PORTAL_SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getPortalSecretKey())
    if ((payload as Record<string, unknown>).typ !== "portal") return null
    return payload as { portalUserId: number; tenantId: number; clientId: number }
  } catch {
    return null
  }
}

async function getVendorPortalSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(VENDOR_PORTAL_SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getVendorPortalSecretKey())
    if ((payload as Record<string, unknown>).typ !== "vendor-portal") return null
    return payload as { portalUserId: number; tenantId: number; vendorId: number }
  } catch {
    return null
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const requestId = `req_${crypto.randomUUID()}`
  const responseHeaders = { "x-request-id": requestId }

  // ---- Client portal (SPEC 118): a fully separate auth plane -------------
  if (pathname.startsWith("/portal") || pathname.startsWith("/api/portal")) {
    if (PORTAL_PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next")) {
      const headers = new Headers(request.headers)
      headers.set("x-request-id", requestId)
      headers.set("x-pathname", pathname)
      const response = NextResponse.next({ request: { headers } })
      response.headers.set("x-request-id", requestId)
      return response
    }
    const portalSession = await getPortalSessionFromRequest(request)
    if (!portalSession) {
      if (pathname.startsWith("/api")) {
        return NextResponse.json({ error: "Not authenticated", requestId }, { status: 401, headers: responseHeaders })
      }
      const loginUrl = new URL("/portal/login", request.url)
      if (pathname !== "/portal") loginUrl.searchParams.set("redirect", pathname)
      return NextResponse.redirect(loginUrl)
    }
    // External portal users never bypass platform/tenant maintenance.
    const portalBlocked = await maintenanceGate(
      request,
      { tenantId: Number(portalSession.tenantId) || null, cacheKey: `p:${portalSession.portalUserId}`, hint: null },
      requestId,
    )
    if (portalBlocked) return portalBlocked
    const headers = new Headers(request.headers)
    headers.set("x-request-id", requestId)
    headers.set("x-pathname", pathname)
    const response = NextResponse.next({ request: { headers } })
    response.headers.set("x-request-id", requestId)
    return response
  }

  // ---- Vendor portal (SPEC 119): a fully separate auth plane -------------
  if (pathname.startsWith("/vendor-portal") || pathname.startsWith("/api/vendor-portal")) {
    if (VENDOR_PORTAL_PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next")) {
      const headers = new Headers(request.headers)
      headers.set("x-request-id", requestId)
      headers.set("x-pathname", pathname)
      const response = NextResponse.next({ request: { headers } })
      response.headers.set("x-request-id", requestId)
      return response
    }
    const vendorSession = await getVendorPortalSessionFromRequest(request)
    if (!vendorSession) {
      if (pathname.startsWith("/api")) {
        return NextResponse.json({ error: "Not authenticated", requestId }, { status: 401, headers: responseHeaders })
      }
      const loginUrl = new URL("/vendor-portal/login", request.url)
      if (pathname !== "/vendor-portal") loginUrl.searchParams.set("redirect", pathname)
      return NextResponse.redirect(loginUrl)
    }
    const vendorBlocked = await maintenanceGate(
      request,
      { tenantId: Number(vendorSession.tenantId) || null, cacheKey: `v:${vendorSession.portalUserId}`, hint: null },
      requestId,
    )
    if (vendorBlocked) return vendorBlocked
    const headers = new Headers(request.headers)
    headers.set("x-request-id", requestId)
    headers.set("x-pathname", pathname)
    const response = NextResponse.next({ request: { headers } })
    response.headers.set("x-request-id", requestId)
    return response
  }

  const protectedPath = pathname.startsWith("/dashboard") || pathname.startsWith("/admin") || pathname.startsWith("/modules") || pathname.startsWith("/api/admin") || pathname.startsWith("/api/modules")
  const publicLike = PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next") || pathname.startsWith("/api/auth")
  if (!protectedPath || publicLike) {
    // Spec28 — signed-in callers of other APIs (e.g. /api/hr, /api/tenant) are
    // still subject to maintenance; anonymous/API-key traffic is untouched here.
    if (!publicLike && !isMaintenanceExemptPath(pathname) && request.cookies.has(SESSION_COOKIE)) {
      const s = await getSessionFromRequest(request)
      if (s) {
        const blocked = await maintenanceGate(request, maintenanceSubject(s), requestId)
        if (blocked) return blocked
        const locked = await billingWriteLockGate(request, writeLockSubject(s), requestId)
        if (locked) return locked
      }
    }
    const headers = new Headers(request.headers)
    headers.set("x-request-id", requestId)
    const response = NextResponse.next({ request: { headers } })
    response.headers.set("x-request-id", requestId)
    return response
  }

  const session = await getSessionFromRequest(request)

  if (!session) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Not authenticated", requestId }, { status: 401, headers: responseHeaders })
    }
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("redirect", pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (pathname.startsWith("/admin") && session.role !== "admin") {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }

  const maintenanceBlocked = await maintenanceGate(request, maintenanceSubject(session), requestId)
  if (maintenanceBlocked) return maintenanceBlocked

  // Spec46 — read-only grace / suspension: block mutating APIs for locked tenants.
  const writeLocked = await billingWriteLockGate(request, writeLockSubject(session), requestId)
  if (writeLocked) return writeLocked

  // Forward the subdomain as a PRE-AUTH HINT only (e.g. acme.muenot.app -> "acme").
  // Server code must still derive the authoritative tenant from the verified
  // session (users.tenant_id); this header can never override it. Stripped from
  // the incoming request first so a client cannot spoof it.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.delete("x-tenant-hint")
  requestHeaders.set("x-request-id", requestId)
  requestHeaders.set("x-correlation-id", requestId)
  const subdomain = extractSubdomain(request.nextUrl.hostname)
  if (subdomain) requestHeaders.set("x-tenant-hint", subdomain)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("x-request-id", requestId)
  return response
}

/**
 * Extract a tenant subdomain from the host, ignoring common non-tenant labels
 * and bare/localhost/IP hosts. Returns null when there is no meaningful
 * subdomain. Informational only — see the note at the call site.
 */
function extractSubdomain(hostname: string): string | null {
  if (!hostname || hostname === "localhost") return null
  // Skip raw IP addresses (no meaningful subdomain).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null
  const labels = hostname.split(".")
  if (labels.length < 3) return null
  const candidate = labels[0].toLowerCase()
  const RESERVED = new Set(["www", "app", "admin", "api", "staging", "preview", "vercel"])
  if (RESERVED.has(candidate)) return null
  return candidate
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/modules/:path*",
    "/portal/:path*",
    "/vendor-portal/:path*",
    "/api/:path*",
  ],
}
