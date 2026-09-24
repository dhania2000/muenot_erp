import { NextResponse, type NextRequest } from "next/server"
import { jwtVerify } from "jose"

const SESSION_COOKIE = "ems_session"
const PORTAL_SESSION_COOKIE = "ems_portal_session"
const PUBLIC_PATHS = ["/login", "/api/auth/login"]
// SPEC 118 — Client Portal public entry points (external users).
const PORTAL_PUBLIC_PATHS = ["/portal/login", "/api/portal/auth/login", "/api/portal/auth/logout"]

function getSecretKey() {
  return new TextEncoder().encode(process.env.SESSION_SECRET || "")
}

// Portal tokens are domain-separated from internal tokens (see lib/portal/auth.ts).
function getPortalSecretKey() {
  return new TextEncoder().encode(`${process.env.SESSION_SECRET || ""}:portal`)
}

async function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    return payload as { userId: number; role: "admin" | "employee" }
  } catch {
    return null
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const requestId = `req_${crypto.randomUUID()}`
  const responseHeaders = { "x-request-id": requestId }

  // ---- Client portal (SPEC 118): a fully separate auth plane -------------
  if (pathname.startsWith("/portal") || pathname.startsWith("/api/portal")) {
    if (PORTAL_PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next")) {
      const headers = new Headers(request.headers)
      headers.set("x-request-id", requestId)
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
    const headers = new Headers(request.headers)
    headers.set("x-request-id", requestId)
    const response = NextResponse.next({ request: { headers } })
    response.headers.set("x-request-id", requestId)
    return response
  }

  const protectedPath = pathname.startsWith("/dashboard") || pathname.startsWith("/admin") || pathname.startsWith("/modules") || pathname.startsWith("/api/admin") || pathname.startsWith("/api/modules")
  if (!protectedPath || PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next") || pathname.startsWith("/api/auth")) {
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
  matcher: ["/dashboard/:path*", "/admin/:path*", "/modules/:path*", "/portal/:path*", "/api/:path*"],
}
