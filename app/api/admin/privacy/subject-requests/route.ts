import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { createSubjectRequest, listSubjectRequests } from "@/lib/privacy-subject-store"
import { subjectCatalogForClient } from "@/lib/privacy-subject-catalog"
import { SUBJECT_REQUEST_KINDS, SUBJECT_REQUEST_KIND_LABELS } from "@/lib/privacy-model"

// Spec24 — Data-subject request (DSAR) admin API. Tenant-admin only,
// tenant-scoped, audited. Create rejects a duplicate OPEN request for the same
// kind + subject (idempotency).

export const runtime = "nodejs"

function actorFromGuard(guard: Extract<Awaited<ReturnType<typeof requireTenantAdmin>>, { ok: true }>) {
  return { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const requests = await listSubjectRequests(tenantId)
  return NextResponse.json({
    requests,
    kinds: SUBJECT_REQUEST_KINDS.map((k) => ({ key: k, label: SUBJECT_REQUEST_KIND_LABELS[k] })),
    locations: subjectCatalogForClient(),
  })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ctx = await captureAuditContext(request).catch(() => undefined)
  try {
    const req = await createSubjectRequest(tenantId, body, actorFromGuard(guard), ctx)
    return NextResponse.json({ request: req }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
