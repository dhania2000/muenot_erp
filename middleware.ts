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

  return NextResponse.next()
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/modules/:path*", "/api/admin/:path*", "/api/modules/:path*"],
}
