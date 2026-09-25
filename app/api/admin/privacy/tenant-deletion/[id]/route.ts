import { NextResponse } from "next/server"
import { requireTenantOwner, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import {
  approveTenantDeletion,
  assessDeletionReadiness,
  cancelTenantDeletion,
  executeTenantDeletion,
  getDeletionRequest,
  proveRetention,
  runDeletionExport,
} from "@/lib/tenant-deletion-store"

// Spec24 — Tenant deletion lifecycle actions. Owner-only, tenant-scoped,
// audited. The action is selected by the `action` field:
//   export   → produce the mandatory full-tenant export
//   prove    → record backup/retention obligation proof
//   approve  → final approval (server re-checks the full readiness gate)
//   execute  → mark executed (only after approval + full readiness)
//   cancel   → withdraw the request

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantOwner()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const { id } = await params
  const requestId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body?.action ?? "")
  const ctx = await captureAuditContext(request).catch(() => undefined)
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }

  try {
    let req
    switch (action) {
      case "export":
        req = await runDeletionExport(tenantId, requestId, actor, ctx)
        break
      case "prove":
        req = await proveRetention(tenantId, requestId, { proven: body?.proven !== false, note: body?.note }, actor, ctx)
        break
      case "approve":
        req = await approveTenantDeletion(tenantId, requestId, actor, ctx)
        break
      case "execute":
        req = await executeTenantDeletion(tenantId, requestId, actor, ctx)
        break
      case "cancel":
        req = await cancelTenantDeletion(tenantId, requestId, actor, body?.reason, ctx)
        break
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    const readiness = await assessDeletionReadiness(req)
    return NextResponse.json({ request: req, readiness })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantOwner()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const { id } = await params
  const req = await getDeletionRequest(tenantId, Number(id))
  if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 })
  const readiness = await assessDeletionReadiness(req)
  return NextResponse.json({ request: req, readiness })
}
