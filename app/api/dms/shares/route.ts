import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { listAllShares, listAllShareAudit, revokeShare, logAudit } from "@/lib/dms"

export const runtime = "nodejs"

/**
 * SPEC 89 — tenant-wide sharing console feed.
 * Returns every share link in the tenant (admins) or only the links the acting
 * user created (everyone else), each enriched with its public landing URL, plus
 * a recent access-audit feed grouped client-side by share. Revocation is done
 * here so the console can kill a link without opening its document.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const isAdmin = ctx.actor.isAdmin
  const all = await listAllShares()
  const shares = (isAdmin ? all : all.filter((s) => s.createdBy === ctx.session.userId)).map((s) => ({
    ...s,
    url: `${req.nextUrl.origin}/d/${s.token}`,
  }))

  // Scope the audit feed to the visible shares so a non-admin never sees events
  // for links they cannot otherwise see.
  const visibleIds = new Set(shares.map((s) => s.id))
  const audit = (await listAllShareAudit(500)).filter(
    (a) => a.shareId != null && visibleIds.has(a.shareId),
  )

  return NextResponse.json({ shares, audit, isAdmin })
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx

  const shareId = Number(req.nextUrl.searchParams.get("shareId"))
  if (!shareId) return NextResponse.json({ error: "shareId is required" }, { status: 400 })

  const all = await listAllShares()
  const share = all.find((s) => s.id === shareId)
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!ctx.actor.isAdmin && share.createdBy !== ctx.session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  await revokeShare(shareId)
  await logAudit({
    documentId: share.documentId,
    shareId,
    action: "revoke_share",
    detail: "console",
    userId: ctx.session.userId,
  })
  return NextResponse.json({ ok: true })
}
