import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { requireDms, isResponse } from "@/lib/dms/request"
import {
  listAccessibleDocuments,
  createDocument,
  getDocument,
  setDocumentFile,
  logAudit,
  DMS_MODULE,
  DMS_ENTITY_TYPE,
  type DocumentFilter,
  type DocStatus,
} from "@/lib/dms"
import { uploadFile } from "@/lib/storage"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const sp = req.nextUrl.searchParams
  const filter: DocumentFilter = {}
  const folderId = sp.get("folderId")
  if (folderId === "root") filter.folderId = null
  else if (folderId) filter.folderId = Number(folderId)
  const categoryId = sp.get("categoryId")
  if (categoryId) filter.categoryId = Number(categoryId)
  const tagId = sp.get("tagId")
  if (tagId) filter.tagId = Number(tagId)
  const status = sp.get("status")
  if (status) filter.status = status as DocStatus
  const search = sp.get("q")
  if (search) filter.search = search
  const sourceModule = sp.get("sourceModule")
  if (sourceModule) filter.sourceModule = sourceModule

  const documents = await listAccessibleDocuments(ctx.actor, filter)
  return NextResponse.json({ documents, isAdmin: ctx.actor.isAdmin, userId: ctx.actor.userId })
}

export async function POST(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const form = await req.formData()
  const title = String(form.get("title") ?? "").trim()
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 })

  const description = form.get("description") ? String(form.get("description")) : null
  const folderIdRaw = form.get("folderId")
  const folderId = folderIdRaw ? Number(folderIdRaw) : null
  const categoryIdRaw = form.get("categoryId")
  const categoryId = categoryIdRaw ? Number(categoryIdRaw) : null
  const status = (form.get("status") ? String(form.get("status")) : "active") as DocStatus
  const expiresAt = form.get("expiresAt") ? String(form.get("expiresAt")) : null
  const tagsRaw = form.get("tags") ? String(form.get("tags")) : ""
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

  const doc = await createDocument({
    title,
    description,
    folderId,
    categoryId,
    status,
    expiresAt,
    tags,
    ownerId: ctx.session.userId,
    createdBy: ctx.session.userId,
  })

  const file = form.get("file")
  if (file instanceof File && file.size > 0) {
    const up = await uploadFile(`dms/${doc.id}/${randomUUID()}`, file, {
      metadata: {
        module: DMS_MODULE,
        entityType: DMS_ENTITY_TYPE,
        entityId: doc.id,
        ownerId: ctx.session.userId,
      },
    })
    if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })
    if (up.result.file) await setDocumentFile(doc.id, up.result.file.id)
  }

  await logAudit({ documentId: doc.id, action: "create", detail: title, userId: ctx.session.userId })
  const created = await getDocument(doc.id)
  return NextResponse.json({ document: created }, { status: 201 })
}
