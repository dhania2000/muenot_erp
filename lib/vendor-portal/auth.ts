import "server-only"
import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { setCurrentTenant } from "@/lib/tenant-context"
import { VENDOR_PORTAL_SESSION_COOKIE } from "@/lib/vendor-portal/config"

/**
 * SPEC 119 — Vendor Portal · external-user session (Phase 2).
 * ---------------------------------------------------------------------------
 * Deliberately SEPARATE from lib/auth.ts (internal users) AND lib/portal/auth.ts
 * (client-portal users). Vendor tokens:
 *   - live in their own cookie (ems_vendor_portal_session),
 *   - are signed with a key DERIVED from SESSION_SECRET but domain-separated
 *     with a ":vendor-portal" suffix, so no token from another plane can be
 *     replayed here (and vice-versa), even though all share the base secret,
 *   - carry a `typ: "vendor-portal"` claim that is asserted on verify.
 *
 * As a side effect of getVendorPortalSession(), the acting tenant is pushed
 * into the per-request tenant context so the data-layer guard is satisfied and
 * every vendor-portal query is scoped to the verified tenant.
 */

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7 // 7 days

function getSecretKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    console.warn("[v0] SESSION_SECRET is not set. Using an insecure fallback — do not use in production.")
  }
  // Domain separation: vendor-portal tokens use a different key than every other plane.
  return new TextEncoder().encode(`${secret || "dev-only-insecure-secret-change-me"}:vendor-portal`)
}

export type VendorPortalSessionPayload = {
  typ: "vendor-portal"
  portalUserId: number
  tenantId: number
  vendorId: number
  email: string
  name: string
}

export async function createVendorPortalSessionToken(
  payload: Omit<VendorPortalSessionPayload, "typ">,
  durationSeconds: number = SESSION_DURATION_SECONDS,
): Promise<string> {
  return new SignJWT({ ...payload, typ: "vendor-portal" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${durationSeconds}s`)
    .sign(getSecretKey())
}

export async function verifyVendorPortalSessionToken(token: string): Promise<VendorPortalSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    if ((payload as Record<string, unknown>).typ !== "vendor-portal") return null
    const p = payload as unknown as VendorPortalSessionPayload
    if (typeof p.portalUserId !== "number" || typeof p.tenantId !== "number" || typeof p.vendorId !== "number") {
      return null
    }
    return p
  } catch {
    return null
  }
}

/**
 * Read the vendor-portal session from cookies. On success, pushes the verified
 * tenant into the per-request tenant context so downstream queries are
 * tenant-scoped. The vendor_id is NEVER read from client input — callers must
 * take it from the returned session.
 */
export async function getVendorPortalSession(): Promise<VendorPortalSessionPayload | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(VENDOR_PORTAL_SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifyVendorPortalSessionToken(token)
  if (!session) return null
  setCurrentTenant({ tenantId: session.tenantId })
  return session
}

export async function setVendorPortalSessionCookie(token: string, durationSeconds: number = SESSION_DURATION_SECONDS) {
  const cookieStore = await cookies()
  cookieStore.set(VENDOR_PORTAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: durationSeconds,
  })
}

export async function clearVendorPortalSessionCookie() {
  const cookieStore = await cookies()
  cookieStore.delete(VENDOR_PORTAL_SESSION_COOKIE)
}
