import "server-only"
import { query } from "@/lib/db"
import { getTenantId, requireFeature, requireModuleAction } from "@/lib/api-auth"

/**
 * The company-operations tables (fixed_assets, employee_asset_assignments,
 * company_subscriptions, expenses, …) are global ERP tables with no tenant_id
 * column. They belong to the platform-owner tenant — the company running this
 * ERP — and must never be readable or writable from a customer SaaS tenant,
 * whose own billing lives in lib/billing/* (Muenot SaaS subscriptions).
 *
 * True only for the platform-owner tenant. Fails closed: any error, a null
 * tenant, or a missing flag means the ledger is NOT accessible.
 */
export async function ownsGlobalErpLedger(tenantId: number | null): Promise<boolean> {
  if (tenantId == null) return false
  try {
    const rows = (await query("SELECT is_platform_owner FROM `tenants` WHERE id = ? LIMIT 1", [tenantId])) as any[]
    return Number(rows[0]?.is_platform_owner ?? 0) === 1
  } catch (err) {
    console.error("[v0] ownsGlobalErpLedger check failed:", err)
    return false
  }
}

type GuardSession = NonNullable<Awaited<ReturnType<typeof requireFeature>>>

export type CompanyOpsGuard =
  | { ok: true; session: GuardSession; tenantId: number }
  | { ok: false; status: 403 | 404; error: string }

/**
 * Route guard for company-operations APIs: permission first, then tenant
 * ownership. A foreign tenant receives 404 (not 403) so the existence of the
 * platform ledger's records is not disclosed.
 */
export async function guardCompanyOps(
  perm: { feature: string } | { module: string; action: string },
): Promise<CompanyOpsGuard> {
  const session =
    "feature" in perm ? await requireFeature(perm.feature) : await requireModuleAction(perm.module, perm.action)
  if (!session) return { ok: false, status: 403, error: "Forbidden" }
  const tenantId = await getTenantId()
  if (tenantId == null || !(await ownsGlobalErpLedger(tenantId))) {
    return { ok: false, status: 404, error: "Not found" }
  }
  return { ok: true, session, tenantId }
}

/** Idempotency-Key header, trimmed and bounded; null when absent or malformed. */
export function idempotencyKeyFrom(req: Request): string | null {
  const raw = req.headers.get("idempotency-key")?.trim()
  if (!raw) return null
  return /^[A-Za-z0-9._:-]{8,120}$/.test(raw) ? raw : null
}
