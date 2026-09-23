import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { requireDms, isResponse } from "@/lib/dms/request"
import {
  registerModuleDocument,
  listEntityDocuments,
  setDocumentFile,
  getDocument,
  logAudit,
  DMS_MODULE,
  DMS_ENTITY_TYPE,
  type DocStatus,
} from "@/lib/dms"
import { uploadFile } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * SPEC 86 — cross-module document endpoint.
 * GET  /api/dms/entity?module=hr&entityType=employee&entityId=42
 *      → documents linked to that record the caller may view.
 * POST (multipart) with module/entityType/entityId/title (+ optional file)
 *      → registers a document against the record in the central DMS.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const sp = req.nextUrl.searchParams
  const module = sp.get("module")?.trim()
  const entityType = sp.get("entityType")?.trim()
  const entityId = sp.get("entityId")?.trim()
  if (!module || !entityType || !entityId) {
    return NextResponse.json(
      { error: "module, entityType and entityId are required" },
      { status: 400 },
    )
  }

  const documents = await listEntityDocuments(ctx.actor, { module, entityType, entityId }, {
    search: sp.get("q") ?? undefined,
  })
  return NextResponse.json({ documents, isAdmin: ctx.actor.isAdmin, userId: ctx.actor.userId })
}

export async function POST(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const form = await req.formData()
  const module = String(form.get("module") ?? "").trim()
  const entityType = String(form.get("entityType") ?? "").trim()
  const entityId = String(form.get("entityId") ?? "").trim()
  const title = String(form.get("title") ?? "").trim()
  if (!module || !entityType || !entityId) {
    return NextResponse.json(
      { error: "module, entityType and entityId are required" },
      { status: 400 },
    )
  }
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 })

  const description = form.get("description") ? String(form.get("description")) : null
  const categoryIdRaw = form.get("categoryId")
  const categoryId = categoryIdRaw ? Number(categoryIdRaw) : null
  const status = (form.get("status") ? String(form.get("status")) : "active") as DocStatus
  const expiresAt = form.get("expiresAt") ? String(form.get("expiresAt")) : null
  const tags = (form.get("tags") ? String(form.get("tags")) : "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

  const doc = await registerModuleDocument({
    module,
    entityType,
    entityId,
    title,
    description,
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

  await logAudit({
    documentId: doc.id,
    action: "create",
    detail: `${module}:${entityType}:${entityId}`,
    userId: ctx.session.userId,
  })
  const created = await getDocument(doc.id)
  return NextResponse.json({ document: created }, { status: 201 })
}
