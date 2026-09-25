import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getSubjectRequest, planSubjectRequest } from "@/lib/privacy-subject-store"

// Spec24 — DSAR detail + live assessment. Returns the request plus the resolved
// per-location plan (match counts, retention conflicts, legal-hold blocks) so
// an admin sees the evidence before approving a destructive request.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const { id } = await params
  const req = await getSubjectRequest(tenantId, Number(id))
  if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 })
  const { assessments, plan } = await planSubjectRequest(tenantId, req.kind, req.subjectEmail)
  return NextResponse.json({ request: req, assessments, plan })
}
