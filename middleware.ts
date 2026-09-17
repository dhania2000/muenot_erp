import { NextResponse, type NextRequest } from "next/server"
import { jwtVerify } from "jose"

const SESSION_COOKIE = "ems_session"
const PUBLIC_PATHS = ["/login", "/api/auth/login"]

function getSecretKey() {
  return new TextEncoder().encode(process.env.SESSION_SECRET || "")
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith("/_next") || pathname.startsWith("/api/auth")) {
    return NextResponse.next()
  }

  const session = await getSessionFromRequest(request)

  if (!session) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
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
  const subdomain = extractSubdomain(request.nextUrl.hostname)
  if (subdomain) requestHeaders.set("x-tenant-hint", subdomain)

  return NextResponse.next({ request: { headers: requestHeaders } })
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
  matcher: ["/dashboard/:path*", "/admin/:path*", "/modules/:path*", "/api/admin/:path*", "/api/modules/:path*"],
}
