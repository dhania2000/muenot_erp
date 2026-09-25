import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { validateSettingsPatch } from "@/lib/customer-success/model"
import { getSettings, updateSettings } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse, readJson } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function scope() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { error: NextResponse.json({ error: guard.reason }, { status: guard.status, headers: NO_STORE }) }
  const tenantId = effectiveTenantId(guard.ctx)
  if (!tenantId || tenantId < 1) return { error: NextResponse.json({ error: "Tenant required" }, { status: 403, headers: NO_STORE }) }
  return { guard, tenantId }
}

export async function GET() {
  const s = await scope()
  if ("error" in s) return s.error
  try {
    return NextResponse.json({ settings: await getSettings(s.tenantId) }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to load analytics settings")
  }
}

/**
 * Body: { analyticsOptOut?: boolean, retentionDays?: 30-730 }. PUT semantics —
 * repeating the same body is a no-op (no write, no audit). Opting out purges
 * the tenant's raw events immediately.
 */
export async function PUT(req: Request) {
  const s = await scope()
  if ("error" in s) return s.error
  try {
    const patch = validateSettingsPatch(await readJson(req))
    const result = await updateSettings(s.tenantId, patch, s.guard.session.userId)
    if (result.changed) {
      await recordAuditLogFromRequest(req, {
        action: "customer_success.settings_updated",
        entityType: "CustomerSuccessSettings",
        entityId: s.tenantId,
        before: result.before,
        after: result.settings,
        metadata: { purgedEvents: result.purgedEvents },
        context: { tenantId: s.tenantId },
      })
    }
    return NextResponse.json({ settings: result.settings, changed: result.changed, purgedEvents: result.purgedEvents }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to update analytics settings")
  }
}
