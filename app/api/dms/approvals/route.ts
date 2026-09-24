import { NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { listWorkflowDocuments } from "@/lib/dms"
import { getRequestDetail, type ApprovalStepRecord } from "@/lib/approval-authority"

export const runtime = "nodejs"

/**
 * SPEC 87 — feed for the Document Approval console. Returns every document in
 * (or having completed) an approval workflow, enriched with the bound approval
 * request's current level and step chain, plus per-user flags describing what
 * the signed-in user can do with each item (act on it, or withdraw it).
 */
export async function GET() {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const userId = ctx.session.userId
  const isAdmin = ctx.session.role === "admin"
  const docs = await listWorkflowDocuments()

  const items = await Promise.all(
    docs.map(async (document) => {
      let request = null
      let steps: ApprovalStepRecord[] = []
      if (document.approvalRequestId != null) {
        const detail = await getRequestDetail(document.approvalRequestId).catch(() => null)
        if (detail) {
          request = detail.request
          steps = detail.steps
        }
      }
      const isPending = request?.status === "pending"
      const canAct =
        isPending &&
        steps.some(
          (s) =>
            s.levelNo === request?.currentLevel &&
            s.decision === "pending" &&
            (s.approverUserId === userId || (isAdmin && s.approverUserId == null)),
        )
      const isRequester = request?.requestedBy === userId

      return { document, request, steps, canAct, isRequester }
    }),
  )

  return NextResponse.json({ items, currentUserId: userId, isAdmin })
}
