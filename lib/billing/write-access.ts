import "server-only"
import { query } from "@/lib/db"
import { toISODate } from "@/lib/billing/subscription-lifecycle"
import {
  deriveWriteAccess,
  type SubscriptionAccessRow,
  type WriteAccessState,
} from "@/lib/billing/write-lock-model"

/**
 * Spec46 — resolve a tenant's write access from its latest engine
 * subscription. The tenant id is always supplied by trusted server code (the
 * verified session, or the token-guarded internal feed); the query is bound
 * to that single tenant.
 */
export async function resolveTenantWriteAccess(
  tenantId: number,
  now: string = toISODate(new Date()),
): Promise<WriteAccessState> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) return deriveWriteAccess(null, now)
  let rows: SubscriptionAccessRow[]
  try {
    rows = await query<SubscriptionAccessRow[]>(
      "SELECT * FROM `saas_subscriptions` WHERE `tenant_id` = ? ORDER BY `id` DESC LIMIT 1",
      [tenantId],
    )
  } catch (err: any) {
    // The engine table is created lazily; a tenant with no engine billing yet
    // has nothing to lock.
    if (err?.code === "ER_NO_SUCH_TABLE") return deriveWriteAccess(null, now)
    throw err
  }
  return deriveWriteAccess(rows[0] ?? null, now)
}
