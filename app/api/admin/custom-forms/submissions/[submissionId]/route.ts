import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { reviewSubmission } from "@/lib/custom-forms/service"

export const dynamic = "force-dynamic"

/**
 * Approve / reject a submission. The reviewer's tenant role is resolved
 * server-side and passed to the model, which enforces that only a role at or
 * above the form's approver role may decide — the client cannot escalate.
 */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenant = getCurrentTenant()
  if (!tenant) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const roleCtx = await resolveRoleContext(session)
  if (!roleCtx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const submissionId = Number((await params).submissionId)
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    return NextResponse.json({ error: "Invalid submission id." }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const decision = body?.decision
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "Decision must be 'approve' or 'reject'." }, { status: 400 })
  }

  const result = await reviewSubmission(
    submissionId,
    decision,
    roleCtx.tenantRole,
    session.userId,
    String(body?.note ?? ""),
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ submission: result.submission })
}
