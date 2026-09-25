import { NextResponse } from "next/server"
import { requireTenantOwner, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import {
  assessDeletionReadiness,
  getActiveDeletionRequest,
  listDeletionRequests,
  requestTenantDeletion,
} from "@/lib/tenant-deletion-store"
import { TENANT_DELETION_COOLING } from "@/lib/privacy-model"

// Spec24 — Tenant deletion admin API. Owner-only (the most privileged tenant
// role), tenant-scoped and audited. Only one active request may exist; a repeat
// request returns the existing one (idempotency).

export const runtime = "nodejs"

function actorFromGuard(guard: Extract<Awaited<ReturnType<typeof requireTenantOwner>>, { ok: true }>) {
  return { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
}

export async function GET() {
  const guard = await requireTenantOwner()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const active = await getActiveDeletionRequest(tenantId)
  const readiness = active ? await assessDeletionReadiness(active) : null
  const history = await listDeletionRequests(tenantId)
  return NextResponse.json({ active, readiness, history, cooling: TENANT_DELETION_COOLING })
}

export async function POST(request: Request) {
  const guard = await requireTenantOwner()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ctx = await captureAuditContext(request).catch(() => undefined)
  try {
    const req = await requestTenantDeletion(tenantId, body, actorFromGuard(guard), ctx)
    const readiness = await assessDeletionReadiness(req)
    return NextResponse.json({ request: req, readiness }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
