import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import { getDocument, listDocumentVersions, logAudit, canPerform } from "@/lib/dms"
import { getFileById, getSignedDownloadUrl } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * Resolve a short-lived signed URL for the document's current file (or a
 * specific version via ?fileId=). Requires `download` access. Returns JSON with
 * the URL so the client can open it inline (?disposition=inline) or download.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!canPerform("download", access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const versions = await listDocumentVersions(docId)
  const fileIdParam = req.nextUrl.searchParams.get("fileId")
  const fileId = fileIdParam ? Number(fileIdParam) : doc.fileId
  if (!fileId) return NextResponse.json({ error: "No file attached" }, { status: 404 })
  // Only files that belong to THIS document's version chain are downloadable.
  if (!versions.some((v) => v.id === fileId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const file = await getFileById(fileId).catch(() => null)
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const disposition = req.nextUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment"
  const signed = await getSignedDownloadUrl(file.objectKey, { expiresIn: 300 })
  const sep = signed.includes("?") ? "&" : "?"
  const filename = file.filename ?? doc.title
  const url = `${signed}${sep}disposition=${disposition}&filename=${encodeURIComponent(filename)}`

  await logAudit({ documentId: docId, action: "download", detail: filename, userId: ctx.session.userId })
  return NextResponse.json({ url, filename })
}
