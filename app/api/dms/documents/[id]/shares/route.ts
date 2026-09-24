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
  normalizeRecipientType,
  normalizeShareAccess,
} from "@/lib/dms"
import { hashSharePassword } from "@/lib/dms/share-access"

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

/** Public landing page for a share link (not the raw API redirect). */
function shareUrl(req: NextRequest, token: string): string {
  return `${req.nextUrl.origin}/d/${token}`
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
  const access = normalizeShareAccess(body.access)
  const recipientType = normalizeRecipientType(body.recipientType)

  // Recipient scoping: internal links bind a user id, team links bind a role,
  // external links carry an email address. Link (anyone) has no recipient.
  let recipient: string | null = null
  if (recipientType === "internal" || recipientType === "team") {
    recipient = body.recipient != null ? String(body.recipient).trim() : ""
    if (!recipient) {
      return NextResponse.json(
        { error: recipientType === "internal" ? "A user is required for internal links" : "A role is required for team links" },
        { status: 400 },
      )
    }
  } else if (recipientType === "external") {
    recipient = body.recipient != null ? String(body.recipient).trim().toLowerCase() : null
    if (recipient && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      return NextResponse.json({ error: "Enter a valid recipient email" }, { status: 400 })
    }
  }

  // Expiry — validate and reject a date already in the past.
  let expiresAt: string | null = null
  if (body.expiresAt) {
    const d = new Date(String(body.expiresAt))
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 })
    }
    if (d.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Expiry must be in the future" }, { status: 400 })
    }
    expiresAt = d.toISOString()
  }

  // Download cap only applies to download links.
  let maxDownloads: number | null = null
  if (body.maxDownloads != null && body.maxDownloads !== "") {
    const n = Number(body.maxDownloads)
    if (!Number.isInteger(n) || n <= 0 || n > 100000) {
      return NextResponse.json({ error: "Download limit must be a positive whole number" }, { status: 400 })
    }
    maxDownloads = access === "download" ? n : null
  }

  // Password protection — hashed server-side; plaintext never persisted.
  let passwordHash: string | null = null
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 4) {
      return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 })
    }
    passwordHash = await hashSharePassword(body.password)
  }

  const label = typeof body.label === "string" ? body.label.trim() : null
  const token = generateShareToken()

  const share = await createShare({
    documentId: docId,
    token,
    access,
    recipientType,
    recipient,
    label: label || null,
    passwordHash,
    maxDownloads,
    expiresAt,
    createdBy: ctx.session.userId,
  })
  await logAudit({
    documentId: docId,
    shareId: share.id,
    action: "share",
    detail: `access=${access} recipient=${recipientType}${expiresAt ? " expiring" : ""}${passwordHash ? " password" : ""}${maxDownloads ? ` max=${maxDownloads}` : ""}`,
    userId: ctx.session.userId,
  })
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
  await logAudit({ documentId: docId, shareId, action: "revoke_share", userId: ctx.session.userId })
  return NextResponse.json({ ok: true })
}
