import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import {
  getDocument,
  logAudit,
  canPerform,
  canTransition,
  normalizeWorkflowType,
  setDocumentWorkflow,
} from "@/lib/dms"
import { submitDocumentForApproval, handleDocumentApprovalOutcome } from "@/lib/dms/approval"
import { actOnApprovalRequest } from "@/lib/approval-authority"

export const runtime = "nodejs"

/**
 * SPEC 87 — drive a document through the configurable Approval Authority engine.
 *
 * Documents never approve themselves: `submit` routes the document into the
 * engine under its workflow type, and `approve`/`reject`/`withdraw` act on the
 * bound approval request so segregation-of-duties, multi-level chains, quorum,
 * delegation and escalation are all enforced by the engine. The outcome is
 * synced back onto the document lifecycle via the DMS approval bridge.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)

  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? "")
  const actor = {
    userId: ctx.session.userId,
    name: ctx.session.name ?? null,
    role: ctx.session.role ?? null,
  }
  const isAdmin = ctx.session.role === "admin"

  switch (action) {
    case "submit": {
      if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      if (doc.approvalStatus === "pending") {
        return NextResponse.json({ error: "This document is already awaiting approval." }, { status: 400 })
      }
      const workflowType = normalizeWorkflowType(body.workflowType)
      if (!workflowType) {
        return NextResponse.json({ error: "A valid workflow type is required." }, { status: 400 })
      }
      const result = await submitDocumentForApproval({ documentId: docId, workflowType, actor })
      await logAudit({ documentId: docId, action: "approval_submit", detail: workflowType, userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId), result })
    }

    case "approve":
    case "reject": {
      if (!doc.approvalRequestId) {
        return NextResponse.json({ error: "This document has not been submitted for approval." }, { status: 400 })
      }
      const result = await actOnApprovalRequest(
        {
          requestId: doc.approvalRequestId,
          actorId: actor.userId,
          actorName: actor.name,
          action,
          comment: typeof body.comment === "string" ? body.comment : null,
        },
        { isAdmin },
      )
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
      await handleDocumentApprovalOutcome(doc.approvalRequestId, result.status)
      await logAudit({ documentId: docId, action: `approval_${action}`, userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId), status: result.status })
    }

    case "withdraw": {
      if (!doc.approvalRequestId) {
        return NextResponse.json({ error: "There is no active approval to withdraw." }, { status: 400 })
      }
      const result = await actOnApprovalRequest(
        {
          requestId: doc.approvalRequestId,
          actorId: actor.userId,
          actorName: actor.name,
          action: "cancel",
          comment: typeof body.comment === "string" ? body.comment : null,
        },
        { isAdmin },
      )
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
      await handleDocumentApprovalOutcome(doc.approvalRequestId, result.status)
      await logAudit({ documentId: docId, action: "approval_withdraw", userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId), status: result.status })
    }

    case "publish": {
      if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      if (!canTransition(doc.status, "published")) {
        return NextResponse.json(
          { error: "Only an approved document can be published." },
          { status: 400 },
        )
      }
      await setDocumentWorkflow(docId, { status: "published" })
      await logAudit({ documentId: docId, action: "approval_publish", userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId) })
    }

    case "archive": {
      if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      await setDocumentWorkflow(docId, { status: "archived" })
      await logAudit({ documentId: docId, action: "approval_archive", userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId) })
    }

    case "revert": {
      if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      // Return a rejected/withdrawn document to draft so it can be edited and
      // resubmitted. Clears the stale engine linkage but keeps the workflow type
      // as a sensible default for the next submission.
      await setDocumentWorkflow(docId, {
        status: "draft",
        approvalStatus: "none",
        approvalRequestId: null,
        approvedBy: null,
        approvedAt: null,
        workflowType: doc.workflowType,
      })
      await logAudit({ documentId: docId, action: "approval_revert", userId: actor.userId })
      return NextResponse.json({ document: await getDocument(docId) })
    }

    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }
}
