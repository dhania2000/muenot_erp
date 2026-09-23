import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import {
  getDocument,
  updateDocument,
  softDeleteDocument,
  listDocumentVersions,
  listDocumentPermissions,
  listShares,
  listAudit,
  logAudit,
  canPerform,
  type DocStatus,
} from "@/lib/dms"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const versions = await listDocumentVersions(docId)
  const audit = await listAudit(docId, 100)
  const permissions = canPerform("manage_permissions", access) ? await listDocumentPermissions(docId) : []
  const shares = canPerform("share", access) ? await listShares(docId) : []

  return NextResponse.json({ document: { ...doc, access }, access, versions, permissions, shares, audit })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if ("title" in body) patch.title = String(body.title)
  if ("description" in body) patch.description = body.description == null ? null : String(body.description)
  if ("status" in body) patch.status = body.status as DocStatus
  if ("expiresAt" in body) patch.expiresAt = body.expiresAt == null ? null : String(body.expiresAt)
  if ("folderId" in body) patch.folderId = body.folderId == null ? null : Number(body.folderId)
  if ("categoryId" in body) patch.categoryId = body.categoryId == null ? null : Number(body.categoryId)
  if ("tags" in body) {
    patch.tags = Array.isArray(body.tags)
      ? body.tags.map((t: unknown) => String(t))
      : String(body.tags ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
  }

  await updateDocument(docId, patch)
  await logAudit({ documentId: docId, action: "update", userId: ctx.session.userId })
  const updated = await getDocument(docId)
  return NextResponse.json({ document: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!canPerform("delete", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await softDeleteDocument(docId, ctx.session.userId)
  await logAudit({ documentId: docId, action: "delete", detail: doc.title, userId: ctx.session.userId })
  return NextResponse.json({ ok: true })
}
