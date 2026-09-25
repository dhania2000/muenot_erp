import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { CustomerSuccessError } from "@/lib/customer-success/model"
import { getSettings, isUserOptedOut, setUserOptOut } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse, readJson } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function selfScope() {
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401, headers: NO_STORE }) }
  const tenantId = Number(session.tenantId)
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return { error: NextResponse.json({ error: "No tenant in context" }, { status: 403, headers: NO_STORE }) }
  }
  return { session, tenantId }
}

/** The caller's own analytics opt-out state (plus whether the tenant disabled analytics). */
export async function GET() {
  const scope = await selfScope()
  if ("error" in scope) return scope.error
  try {
    const [optedOut, settings] = await Promise.all([isUserOptedOut(scope.tenantId, scope.session.userId), getSettings(scope.tenantId)])
    return NextResponse.json({ optedOut, tenantOptedOut: settings.analyticsOptOut }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to load opt-out state")
  }
}

/** Body: { optOut: boolean }. Only ever affects the caller. Idempotent; audited on change. */
export async function PUT(req: Request) {
  const scope = await selfScope()
  if ("error" in scope) return scope.error
  try {
    const body = (await readJson(req)) as { optOut?: unknown } | null
    if (typeof body?.optOut !== "boolean") throw new CustomerSuccessError("optOut must be a boolean", "INVALID_OPT_OUT")
    const result = await setUserOptOut(scope.tenantId, scope.session.userId, body.optOut)
    if (result.changed) {
      await recordAuditLogFromRequest(req, {
        action: body.optOut ? "customer_success.user_opted_out" : "customer_success.user_opted_in",
        entityType: "AnalyticsOptOut",
        entityId: scope.session.userId,
        metadata: { purgedEvents: result.purgedEvents },
      })
    }
    return NextResponse.json({ optedOut: body.optOut, ...result }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to update opt-out")
  }
}
