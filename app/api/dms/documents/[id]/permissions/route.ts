import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import {
  getDocument,
  listDocumentPermissions,
  addPermission,
  removePermission,
  logAudit,
  canPerform,
  type AccessLevel,
  type SubjectType,
} from "@/lib/dms"

export const runtime = "nodejs"

async function guard(session: import("@/lib/auth").SessionPayload, docId: number) {
  const doc = await getDocument(docId)
  if (!doc) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) }
  const access = await effectiveAccess(session, doc)
  if (!canPerform("manage_permissions", access)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { doc }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error
  return NextResponse.json({ permissions: await listDocumentPermissions(docId) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error

  const body = await req.json().catch(() => ({}))
  const subjectType = String(body.subjectType ?? "user") as SubjectType
  const subjectId = String(body.subjectId ?? "").trim()
  const accessLevel = String(body.accessLevel ?? "view") as AccessLevel
  if (!subjectId) return NextResponse.json({ error: "subjectId is required" }, { status: 400 })

  const permission = await addPermission({
    documentId: docId,
    subjectType,
    subjectId,
    accessLevel,
    createdBy: ctx.session.userId,
  })
  await logAudit({
    documentId: docId,
    action: "grant",
    detail: `${subjectType}:${subjectId} → ${accessLevel}`,
    userId: ctx.session.userId,
  })
  return NextResponse.json({ permission }, { status: 201 })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error

  const permId = Number(req.nextUrl.searchParams.get("permId"))
  if (!permId) return NextResponse.json({ error: "permId is required" }, { status: 400 })
  await removePermission(permId)
  await logAudit({ documentId: docId, action: "revoke_grant", userId: ctx.session.userId })
  return NextResponse.json({ ok: true })
}
