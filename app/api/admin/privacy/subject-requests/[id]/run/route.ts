import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { runSubjectRequest } from "@/lib/privacy-subject-store"

// Spec24 — Execute a DSAR. Export runs from pending; erase/anonymize must be
// approved first (enforced by the store's canRunRequest gate). A legal-hold
// conflict never blocks the whole run — held locations are left untouched.

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const { id } = await params
  const ctx = await captureAuditContext(request).catch(() => undefined)
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
  try {
    const result = await runSubjectRequest(tenantId, Number(id), actor, ctx)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
