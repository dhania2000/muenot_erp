import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { captureAuditContext } from "@/lib/audit-log-store"
import { getChecklist, setStepState, setDismissed } from "@/lib/onboarding/store"
import { isChecklistStep, normalizeOverride, OnboardingError } from "@/lib/onboarding/model"
import { NO_STORE, readJson, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

/** Setup is a tenant-admin concern; employees don't see or edit the checklist. */
async function requireAdminTenant() {
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE }) }
  if (session.role !== "admin") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE }) }
  const tenantId = getCurrentTenant()?.tenantId ?? session.tenantId ?? null
  if (tenantId == null) return { error: NextResponse.json({ error: "No tenant in context" }, { status: 400, headers: NO_STORE }) }
  return { session, tenantId }
}

export async function GET() {
  try {
    const auth = await requireAdminTenant()
    if (auth.error) return auth.error
    const checklist = await getChecklist(auth.tenantId)
    return NextResponse.json({ checklist }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to load onboarding checklist")
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireAdminTenant()
    if (auth.error) return auth.error
    const body = (await readJson(request)) as Record<string, unknown>
    const ctx = await captureAuditContext(request)

    if (typeof body.dismissed === "boolean") {
      const res = await setDismissed(auth.tenantId, auth.session.userId, body.dismissed, ctx)
      return NextResponse.json({ changed: res.changed, checklist: res.checklist }, { headers: NO_STORE })
    }

    if (body.step !== undefined || body.state !== undefined) {
      if (!isChecklistStep(body.step)) throw new OnboardingError("Unknown step", "INVALID_STEP")
      const state = normalizeOverride(body.state)
      const res = await setStepState(auth.tenantId, auth.session.userId, body.step, state, ctx)
      return NextResponse.json({ changed: res.changed, checklist: res.checklist }, { headers: NO_STORE })
    }

    throw new OnboardingError("Provide either { step, state } or { dismissed }", "INVALID_INPUT")
  } catch (err) {
    return errorResponse(err, "Failed to update onboarding checklist")
  }
}
