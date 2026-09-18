import { redirect } from "next/navigation"
import { getSession, type SessionPayload } from "@/lib/auth"
import { setCurrentTenant } from "@/lib/tenant-context"

/**
 * Subscription & Billing is an admin-only module (mirrors the Administration
 * gating). Every /modules/billing/* page calls this to enforce the session +
 * role check before rendering.
 */
export async function billingGuard() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")
  return session
}

/**
 * Bind the acting tenant into the async context for the REST of the current
 * request handler.
 *
 * Why this is needed: getSession() records the tenant via
 * AsyncLocalStorage.enterWith(), but that side-effect does NOT reach a route
 * handler's own continuation — the handler resumes from the async context it
 * captured at `await billingGuard()`, which predates getSession's enterWith, so
 * getCurrentTenant() reads null and every tenant-scoped billing read/write
 * throws "No tenant in context" (surfacing as the generic "Failed to …" errors
 * seen across the billing submodules). Calling this synchronously in the
 * handler — before any tenant-scoped await — re-binds the tenant so all
 * following awaits in the same handler see it. The tenant is taken only from
 * the verified session token (getSession backfills session.tenantId), never
 * from client input.
 *
 * Call once, right after the billingGuard()/getSession() check, in any billing
 * route that reads or writes tenant-scoped data.
 */
export function bindBillingTenant(session: SessionPayload): void {
  const tenantId = Number(session.tenantId)
  if (Number.isInteger(tenantId) && tenantId > 0) {
    setCurrentTenant({ tenantId })
  }
}
