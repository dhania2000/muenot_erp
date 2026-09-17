import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-request "which tenant is this" context. Populated as a side-effect of
 * the existing `getSession()` call that virtually every authenticated
 * route/page already makes (see lib/auth.ts), so the data layer can scope
 * reads/writes to the acting tenant WITHOUT every route threading a
 * `tenantId` argument down manually. Mirrors lib/actor-context.ts.
 *
 * SECURITY: the tenant is ALWAYS derived from the verified session token
 * (users.tenant_id captured at login), never from client-supplied input such
 * as a query param, body field, or arbitrary header. A subdomain is only a
 * pre-authentication hint; it can never override the session tenant.
 *
 * Node-only (imports node:async_hooks). Never import this from Edge runtime
 * code (middleware) — the middleware verifies the JWT directly instead.
 */
export type TenantContext = {
  tenantId: number
  /** Slug/subdomain, when known. Informational only. */
  slug?: string
} | null

const storage = new AsyncLocalStorage<{ tenant: TenantContext }>()

/**
 * Record the acting tenant for the remainder of the current async execution.
 * Uses `enterWith` so callers don't need to wrap their handler in `.run()` —
 * calling this early (from `getSession`) makes the tenant visible to every
 * subsequent `await` in the same request without changing existing code.
 */
export function setCurrentTenant(tenant: TenantContext) {
  const store = storage.getStore()
  if (store) {
    store.tenant = tenant
  } else {
    storage.enterWith({ tenant })
  }
}

export function getCurrentTenant(): TenantContext {
  return storage.getStore()?.tenant ?? null
}

/** The current tenant id, or throws if there is no tenant in context. */
export function requireCurrentTenantId(): number {
  const tenant = getCurrentTenant()
  if (!tenant) {
    throw new Error("No tenant in context — this code path requires an authenticated tenant.")
  }
  return tenant.tenantId
}
