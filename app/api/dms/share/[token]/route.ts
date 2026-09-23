import { NextRequest, NextResponse } from "next/server"
import { runForTenant } from "@/lib/tenant-scope"
import {
  getShareByToken,
  getDocument,
  incrementShareDownload,
  shareTokenValid,
} from "@/lib/dms"
import { getFileById, getSignedDownloadUrl } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * Public, unauthenticated share link. This is the only DMS read that runs
 * before a tenant context exists: the token look-up returns the owning tenant,
 * then all subsequent work is bound to that tenant via runForTenant. Redirects
 * to a short-lived signed URL for the document's current file.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await getShareByToken(token)
  if (!found) return NextResponse.json({ error: "Link not found" }, { status: 404 })

  return runForTenant({ tenantId: found.tenantId }, async () => {
    if (!shareTokenValid(found.share)) {
      return NextResponse.json({ error: "This link has expired or been revoked" }, { status: 410 })
    }
    const doc = await getDocument(found.share.documentId)
    if (!doc || !doc.fileId) return NextResponse.json({ error: "Document unavailable" }, { status: 404 })
    const file = await getFileById(doc.fileId).catch(() => null)
    if (!file) return NextResponse.json({ error: "Document unavailable" }, { status: 404 })

    const disposition = found.share.access === "download" ? "attachment" : "inline"
    const signed = await getSignedDownloadUrl(file.objectKey, { expiresIn: 600 })
    const sep = signed.includes("?") ? "&" : "?"
    const filename = file.filename ?? doc.title
    const relative = `${signed}${sep}disposition=${disposition}&filename=${encodeURIComponent(filename)}`

    await incrementShareDownload(found.share.id)
    return NextResponse.redirect(new URL(relative, req.nextUrl.origin))
  })
}
