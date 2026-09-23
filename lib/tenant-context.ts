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
 * Allocate a fresh container BEFORE getSession's first await. The caller's
 * continuation then inherits this same container and sees its verified value.
 * Reusing/mutating an inherited container here would mix concurrent requests.
 */
export function initializeSessionTenantContext() {
  storage.enterWith({ tenant: null })
}

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

/**
 * Run `fn` inside a fresh tenant scope. Unlike `setCurrentTenant`, this uses
 * `storage.run()` so the scope is isolated to this callback and cannot leak
 * into sibling async executions — required for background workers that process
 * several tenants' jobs concurrently and have no per-request session to seed
 * the context.
 */
export function runWithTenant<T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run({ tenant }, fn)
}

/** The current tenant id, or throws if there is no tenant in context. */
export function requireCurrentTenantId(): number {
  const tenant = getCurrentTenant()
  if (!tenant) {
    throw new Error("No tenant in context — this code path requires an authenticated tenant.")
  }
  return tenant.tenantId
}
