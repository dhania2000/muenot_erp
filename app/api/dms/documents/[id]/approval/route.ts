import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import { getDocument, setApproval, logAudit, canPerform } from "@/lib/dms"

export const runtime = "nodejs"

/**
 * Drive the approval workflow.
 * - `submit` moves a document to `pending` and requires edit access.
 * - `approve` / `reject` set the terminal state and require manage access.
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

  if (action === "submit") {
    if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await setApproval(docId, "pending", null)
  } else if (action === "approve" || action === "reject") {
    if (!canPerform("approve", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await setApproval(docId, action === "approve" ? "approved" : "rejected", ctx.session.userId)
  } else if (action === "reset") {
    if (!canPerform("approve", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await setApproval(docId, "none", null)
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }

  await logAudit({ documentId: docId, action: `approval_${action}`, userId: ctx.session.userId })
  const updated = await getDocument(docId)
  return NextResponse.json({ document: updated })
}
