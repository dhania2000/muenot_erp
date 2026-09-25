import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { decideSubjectRequest } from "@/lib/privacy-subject-store"

// Spec24 — Approve or reject a destructive DSAR (erase / anonymize). Export
// requests do not require approval and are rejected by the store here.

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const decision = body?.decision === "reject" ? "reject" : body?.decision === "approve" ? "approve" : null
  if (!decision) return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 })
  const ctx = await captureAuditContext(request).catch(() => undefined)
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
  try {
    const req = await decideSubjectRequest(tenantId, Number(id), decision, actor, ctx)
    return NextResponse.json({ request: req })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
