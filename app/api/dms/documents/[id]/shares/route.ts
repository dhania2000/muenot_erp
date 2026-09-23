import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import {
  getDocument,
  listShares,
  createShare,
  revokeShare,
  generateShareToken,
  logAudit,
  canPerform,
  type ShareAccess,
} from "@/lib/dms"

export const runtime = "nodejs"

async function guard(session: import("@/lib/auth").SessionPayload, docId: number) {
  const doc = await getDocument(docId)
  if (!doc) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) }
  const access = await effectiveAccess(session, doc)
  if (!canPerform("share", access)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { doc }
}

function shareUrl(req: NextRequest, token: string): string {
  return `${req.nextUrl.origin}/api/dms/share/${token}`
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error
  const shares = await listShares(docId)
  return NextResponse.json({ shares: shares.map((s) => ({ ...s, url: shareUrl(req, s.token) })) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error

  const body = await req.json().catch(() => ({}))
  const access = String(body.access ?? "view") as ShareAccess
  const expiresAt = body.expiresAt ? String(body.expiresAt) : null
  const token = generateShareToken()

  const share = await createShare({ documentId: docId, token, access, expiresAt, createdBy: ctx.session.userId })
  await logAudit({ documentId: docId, action: "share", detail: `access=${access}`, userId: ctx.session.userId })
  return NextResponse.json({ share: { ...share, url: shareUrl(req, share.token) } }, { status: 201 })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)
  const g = await guard(ctx.session, docId)
  if (g.error) return g.error

  const shareId = Number(req.nextUrl.searchParams.get("shareId"))
  if (!shareId) return NextResponse.json({ error: "shareId is required" }, { status: 400 })
  await revokeShare(shareId)
  await logAudit({ documentId: docId, action: "revoke_share", userId: ctx.session.userId })
  return NextResponse.json({ ok: true })
}
