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

  // Bytes live in the versions table (file_data). Resolve the requested version,
  // defaulting to the asset's current version.
  const wantedVersion = version || Number(asset.current_version || 1)
  const [v] = (await query(
    `SELECT file_data, storage_url, file_name, file_type FROM marketing_library_versions
      WHERE library_id = ? AND version = ?`,
    [asset.id, wantedVersion],
  )) as any[]
  if (!v) return NextResponse.json({ error: "Version not found" }, { status: 404 })

  const fileName: string = v.file_name || asset.file_name
  const fileType: string = v.file_type || asset.file_type

  if (!preview) {
    await recordAudit("downloaded", {
      libraryId: asset.id,
      assetCode: asset.asset_id,
      detail: `v${wantedVersion}`,
      userId: session.userId,
      userName: session.name,
    })
  }

  const disposition = preview ? "inline" : "attachment"
  const safeName = fileName.replace(/["\\\r\n]/g, "_")
  const headers: Record<string, string> = {
    "Content-Type": fileType || "application/octet-stream",
    "Content-Disposition": `${disposition}; filename="${safeName}"`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  }

  // Preferred path: bytes stored directly in MySQL.
  if (v.file_data) {
    const body = Buffer.isBuffer(v.file_data) ? v.file_data : Buffer.from(v.file_data)
    headers["Content-Length"] = String(body.length)
    return new NextResponse(body, { headers })
  }

  // Legacy fallback: an older asset whose bytes still live in external storage.
  if (v.storage_url) {
    const upstream = await fetch(v.storage_url)
    if (!upstream.ok || !upstream.body)
      return NextResponse.json({ error: "Stored file unavailable" }, { status: 502 })
    return new NextResponse(upstream.body, { headers })
  }

  return NextResponse.json({ error: "No stored file" }, { status: 404 })
}
