import "server-only"
import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { setCurrentTenant } from "@/lib/tenant-context"
import { PORTAL_SESSION_COOKIE } from "@/lib/portal/config"

/**
 * SPEC 118 — Client Portal · external-user session (Phase 2).
 * ---------------------------------------------------------------------------
 * Deliberately SEPARATE from lib/auth.ts (which authenticates internal
 * admin/employee users). Portal tokens:
 *   - live in a different cookie (ems_portal_session),
 *   - are signed with a key DERIVED from SESSION_SECRET but domain-separated
 *     with a ":portal" suffix, so an internal token can never be replayed as a
 *     portal token (and vice-versa), even though both use the same base secret,
 *   - carry a `typ: "portal"` claim that is asserted on verify.
 *
 * As a side effect of getPortalSession(), the acting tenant is pushed into the
 * per-request tenant context so the data-layer guard is satisfied and every
 * portal query is scoped to the verified tenant.
 */

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7 // 7 days

function getSecretKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    console.warn("[v0] SESSION_SECRET is not set. Using an insecure fallback — do not use in production.")
  }
  // Domain separation: portal tokens use a different key than the internal app.
  return new TextEncoder().encode(`${secret || "dev-only-insecure-secret-change-me"}:portal`)
}

export type PortalSessionPayload = {
  typ: "portal"
  portalUserId: number
  tenantId: number
  clientId: number
  email: string
  name: string
}

export async function createPortalSessionToken(
  payload: Omit<PortalSessionPayload, "typ">,
  durationSeconds: number = SESSION_DURATION_SECONDS,
): Promise<string> {
  return new SignJWT({ ...payload, typ: "portal" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${durationSeconds}s`)
    .sign(getSecretKey())
}

export async function verifyPortalSessionToken(token: string): Promise<PortalSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    if ((payload as Record<string, unknown>).typ !== "portal") return null
    const p = payload as unknown as PortalSessionPayload
    if (typeof p.portalUserId !== "number" || typeof p.tenantId !== "number" || typeof p.clientId !== "number") {
      return null
    }
    return p
  } catch {
    return null
  }
}

/**
 * Read the portal session from cookies. On success, pushes the verified tenant
 * into the per-request tenant context so downstream queries are tenant-scoped.
 * The client_id is NEVER read from client input — callers must take it from the
 * returned session.
 */
export async function getPortalSession(): Promise<PortalSessionPayload | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(PORTAL_SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifyPortalSessionToken(token)
  if (!session) return null
  setCurrentTenant({ tenantId: session.tenantId })
  return session
}

export async function setPortalSessionCookie(token: string, durationSeconds: number = SESSION_DURATION_SECONDS) {
  const cookieStore = await cookies()
  cookieStore.set(PORTAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: durationSeconds,
  })
}

export async function clearPortalSessionCookie() {
  const cookieStore = await cookies()
  cookieStore.delete(PORTAL_SESSION_COOKIE)
}
