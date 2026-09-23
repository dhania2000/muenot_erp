import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import {
  getDocument,
  setDocumentFile,
  listDocumentVersions,
  logAudit,
  canPerform,
  DMS_MODULE,
  DMS_ENTITY_TYPE,
} from "@/lib/dms"
import { uploadFile } from "@/lib/storage"

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
  return NextResponse.json({ versions: await listDocumentVersions(docId) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!canPerform("edit", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const form = await req.formData()
  const file = form.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "A file is required" }, { status: 400 })
  }

  const up = await uploadFile(`dms/${docId}/${randomUUID()}`, file, {
    metadata: {
      module: DMS_MODULE,
      entityType: DMS_ENTITY_TYPE,
      entityId: docId,
      ownerId: ctx.session.userId,
    },
  })
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })
  if (up.result.file) await setDocumentFile(docId, up.result.file.id)

  await logAudit({ documentId: docId, action: "version", detail: file.name, userId: ctx.session.userId })
  return NextResponse.json({ versions: await listDocumentVersions(docId) }, { status: 201 })
}
