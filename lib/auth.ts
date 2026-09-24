import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { setCurrentActor } from "./actor-context"
import { initializeSessionTenantContext, setCurrentTenant } from "./tenant-context"
import { isSessionActive, touchSession } from "./session-store"

export const SESSION_COOKIE = "ems_session"
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7 // 7 days

function getSecretKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    // Falls back to an insecure development secret so the app doesn't crash
    // when SESSION_SECRET hasn't been configured yet. Always set a real
    // SESSION_SECRET before deploying to production.
    console.warn("[v0] SESSION_SECRET is not set. Using an insecure fallback — do not use in production.")
  }
  return new TextEncoder().encode(secret || "dev-only-insecure-secret-change-me")
}

export type SessionPayload = {
  userId: number
  email: string
  name: string
  role: "admin" | "employee"
  /**
   * The tenant this user belongs to, captured at login from users.tenant_id.
   * Optional so JWTs issued before the multi-tenant rollout still verify;
   * `getSession()` backfills the default tenant for those legacy tokens.
   */
  tenantId?: number
  /**
   * platform/tenant role axes, captured at login from the DB. Optional
   * so pre- tokens still verify; guards re-resolve from the DB source of
   * truth (lib/platform-roles.ts) rather than trusting these for authorization.
   * They are carried in the token only for cheap, allocation-free UI hints.
   */
  platformRole?: "none" | "platform_staff" | "platform_super_admin"
  tenantRole?: "employee" | "module_admin" | "tenant_admin" | "tenant_owner"
  /**
   * The customer tenant a platform operator has EXPLICITLY entered. Set only by
   * the audited impersonation endpoint, which re-mints the token; never accepted
   * from client input. When present, `getSession()` scopes the data layer to
   * this tenant instead of the operator's home tenant.
   */
  impersonatedTenantId?: number | null
  /**
   * The organization a MULTI-ORG user has actively switched into. Unlike
   * `impersonatedTenantId` (a platform-operator concept), this is available to
   * any user and is only ever honored for a tenant the user holds an ACTIVE
   * membership in (lib/tenant-membership.ts). It is set solely by the audited
   * organization switcher, which re-mints the token after validating membership;
   * `getSession()` re-validates it against live membership on every request, so
   * a revoked membership or a forged/stale field falls closed to the home
   * tenant. Null / absent means the session is scoped to the home tenant.
   */
  activeTenantId?: number | null
  /**
   * opaque session id (jti) that keys the server-side session
   * record in lib/session-store.ts. Optional so tokens issued before the
   * session store existed still verify — `getSession()` treats a missing
   * `sid` as always-active (nothing to revoke it against) rather than
   * failing every pre-existing login.
   */
  sid?: string
}

export async function createSessionToken(
  payload: SessionPayload,
  durationSeconds: number = SESSION_DURATION_SECONDS,
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${durationSeconds}s`)
    .sign(getSecretKey())
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    return payload as unknown as SessionPayload
  } catch {
    return null
  }
}

/** Server Component / Route Handler helper — reads the session from cookies(). */
export async function getSession(): Promise<SessionPayload | null> {
  // Must execute synchronously: initializing only after cookies/JWT awaits
  // leaves the calling route outside the tenant context (e.g. WhatsApp status).
  initializeSessionTenantContext()
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifySessionToken(token)
  if (session) {
    // a cryptographically valid token can still have been revoked
    // (admin-forced sign-out, "sign out all devices", concurrent-session cap).
    // The session store is the live-ness source of truth; a token whose `sid`
    // is missing or revoked there is treated as signed out. Fails open on a
    // store outage so a DB blip never locks everyone out.
    if (session.sid && !(await isSessionActive(session.sid))) {
      return null
    }
    if (session.sid) void touchSession(session.sid)

    // Populate the per-request actor context so DB-layer notification capture
    // can attribute writes to this user without threading it through routes.
    setCurrentActor({
      userId: session.userId,
      name: session.name,
      email: session.email,
      role: session.role,
    })

    // Populate the per-request tenant context so the data layer can scope
    // reads/writes to the acting tenant. The tenant is derived from the
    // verified token (never client input). Legacy tokens without a tenantId
    // are backfilled to the default tenant from the DB source of truth.
    let tenantId = session.tenantId
    if (tenantId == null) {
      try {
        const { resolveTenantIdForUser } = await import("./tenant-service")
        tenantId = (await resolveTenantIdForUser(session.userId)) ?? undefined
        if (tenantId != null) session.tenantId = tenantId
      } catch (err) {
        console.error("[v0] tenant resolution failed:", err)
      }
    }
    // when a platform operator is actively impersonating a customer
    // tenant, the data layer must scope to THAT tenant, not their home tenant.
    // The impersonation id is carried in the verified (signed) token and is
    // only ever set by the audited impersonation endpoint. It is honored here
    // only for a genuine platform operator, so a forged/leftover field on a
    // non-platform token can never redirect scoping to another tenant.
    let effectiveTenantId =
      session.impersonatedTenantId != null &&
      session.platformRole != null &&
      session.platformRole !== "none"
        ? session.impersonatedTenantId
        : tenantId

    // multi-org switching: a user who has switched into another organization
    // carries `activeTenantId` in the verified token. Platform impersonation
    // (above) always wins; otherwise, when the active tenant differs from the
    // home tenant, it is honored ONLY after re-validating a LIVE active
    // membership. This fails closed to the home tenant if the membership was
    // revoked/suspended or the value is stale/forged, so switching can never
    // outlive access.
    const isImpersonating =
      session.impersonatedTenantId != null &&
      session.platformRole != null &&
      session.platformRole !== "none"
    if (
      !isImpersonating &&
      session.activeTenantId != null &&
      session.activeTenantId !== tenantId
    ) {
      try {
        const { isActiveMembership } = await import("./tenant-membership")
        if (await isActiveMembership(session.userId, session.activeTenantId)) {
          effectiveTenantId = session.activeTenantId
        }
      } catch (err) {
        console.error("[v0] active-tenant membership check failed:", err)
      }
    }

    if (effectiveTenantId != null) {
      setCurrentTenant({ tenantId: effectiveTenantId })
    }
  }
  return session
}

export async function setSessionCookie(token: string, durationSeconds: number = SESSION_DURATION_SECONDS) {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: durationSeconds,
  })
}

export async function clearSessionCookie() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}
