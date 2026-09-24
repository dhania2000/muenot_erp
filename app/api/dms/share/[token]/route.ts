import { NextRequest, NextResponse } from "next/server"
import { runForTenant } from "@/lib/tenant-scope"
import { getSession } from "@/lib/auth"
import {
  getShareByToken,
  getDocument,
  incrementShareDownload,
  incrementShareView,
  logAudit,
  evaluateShareAccess,
  type ShareIntent,
} from "@/lib/dms"
import { getFileById, getSignedDownloadUrl } from "@/lib/storage"
import { unlockCookieName, verifyUnlockCookie } from "@/lib/dms/share-access"

export const runtime = "nodejs"

/**
 * SPEC 89 — public, signed document access.
 * This is the only DMS read that runs before a tenant context exists: the token
 * look-up returns the owning tenant, then everything else is bound to that
 * tenant via runForTenant. Access is decided by the pure evaluateShareAccess
 * gate (revoked → expired → recipient scope → password → download policy); a
 * denial redirects back to the landing page so the visitor sees a friendly
 * reason, and every allowed access is recorded in the audit trail.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const intent = (req.nextUrl.searchParams.get("intent") === "download" ? "download" : "view") as ShareIntent
  const found = await getShareByToken(token)
  if (!found) return NextResponse.json({ error: "Link not found" }, { status: 404 })

  const landing = (reason: string) => NextResponse.redirect(new URL(`/d/${token}?error=${reason}`, req.nextUrl.origin))

  // Viewer (if signed in) is needed to satisfy internal/team recipient scoping.
  const session = await getSession().catch(() => null)
  const viewer = session ? { userId: session.userId, role: session.role } : null
  const unlocked = verifyUnlockCookie(token, req.cookies.get(unlockCookieName(token))?.value)

  return runForTenant({ tenantId: found.tenantId }, async () => {
    const decision = evaluateShareAccess({
      share: {
        access: found.share.access,
        expiresAt: found.share.expiresAt,
        revokedAt: found.share.revokedAt,
        recipientType: found.share.recipientType,
        recipient: found.share.recipient,
        hasPassword: found.passwordHash != null,
        maxDownloads: found.share.maxDownloads,
        downloadCount: found.share.downloadCount,
      },
      intent,
      viewer,
      passwordVerified: unlocked,
    })

    if (!decision.ok) {
      await logAudit({
        documentId: found.share.documentId,
        shareId: found.share.id,
        action: "share_denied",
        detail: `${intent}:${decision.reason}`,
        userId: viewer?.userId ?? null,
      })
      return landing(decision.reason)
    }

    const doc = await getDocument(found.share.documentId)
    if (!doc || !doc.fileId) return landing("unavailable")
    const file = await getFileById(doc.fileId).catch(() => null)
    if (!file) return landing("unavailable")

    const disposition = intent === "download" ? "attachment" : "inline"
    const signed = await getSignedDownloadUrl(file.objectKey, { expiresIn: 600 })
    const sep = signed.includes("?") ? "&" : "?"
    const filename = file.filename ?? doc.title
    const relative = `${signed}${sep}disposition=${disposition}&filename=${encodeURIComponent(filename)}`

    if (intent === "download") {
      await incrementShareDownload(found.share.id)
    } else {
      await incrementShareView(found.share.id)
    }
    await logAudit({
      documentId: found.share.documentId,
      shareId: found.share.id,
      action: intent === "download" ? "share_download" : "share_view",
      detail: found.share.recipientType,
      userId: viewer?.userId ?? null,
    })
    return NextResponse.redirect(new URL(relative, req.nextUrl.origin))
  })
}
