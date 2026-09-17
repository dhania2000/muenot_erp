import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureLibrarySchema, canUseLibrary, recordAudit } from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/marketing/library/[id]/download
 * Authorized proxy (Phase 42/43/85). The browser never receives the raw Blob
 * URL — this route checks the session/feature, streams the bytes, and audits
 * real downloads. `?preview=1` marks inline preview traffic (not audited as a
 * download and served with inline disposition).
 * `?version=N` streams a specific historical version.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()

  const { id } = await params
  const url = new URL(request.url)
  const preview = url.searchParams.get("preview") === "1"
  const version = Number(url.searchParams.get("version") || 0)

  const [asset] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [Number(id)])) as any[]
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 })

  let storageUrl: string | null = asset.storage_url
  let fileName: string = asset.file_name
  let fileType: string = asset.file_type
  if (version) {
    const [v] = (await query(
      `SELECT storage_url, file_name, file_type FROM marketing_library_versions WHERE library_id = ? AND version = ?`,
      [asset.id, version],
    )) as any[]
    if (!v) return NextResponse.json({ error: "Version not found" }, { status: 404 })
    storageUrl = v.storage_url
    fileName = v.file_name
    fileType = v.file_type
  }
  if (!storageUrl) return NextResponse.json({ error: "No stored file" }, { status: 404 })

  const upstream = await fetch(storageUrl)
  if (!upstream.ok || !upstream.body)
    return NextResponse.json({ error: "Stored file unavailable" }, { status: 502 })

  if (!preview) {
    await recordAudit("downloaded", {
      libraryId: asset.id,
      assetCode: asset.asset_id,
      detail: version ? `v${version}` : `v${asset.current_version}`,
      userId: session.userId,
      userName: session.name,
    })
  }

  const disposition = preview ? "inline" : "attachment"
  const safeName = fileName.replace(/["\\\r\n]/g, "_")
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": fileType || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename="${safeName}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
