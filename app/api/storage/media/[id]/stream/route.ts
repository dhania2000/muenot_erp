import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getMediaAsset, getMediaStreamUrl } from "@/lib/storage/media"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { canViewMediaModule } from "../../_access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * GET /api/storage/media/[id]/stream
 * Mint a short-lived signed streaming URL (Range/seek-capable) for a media
 * asset. `?redirect=1` 302-redirects straight to the URL for use as a <video>
 * `src`; the default returns JSON `{ url, expiresIn, ... }`.
 * Query `ttl` (seconds) requests a custom lifetime, clamped by the media layer.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const asset = await getMediaAsset(id)
  if (!asset) return NextResponse.json({ error: "Media asset not found" }, { status: 404 })
  if (!(await canViewMediaModule(session, asset.module))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const url = new URL(request.url)
  const ttlRaw = Number(url.searchParams.get("ttl"))
  const expiresIn = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : undefined

  const result = await getMediaStreamUrl(id, { expiresIn })
  if (!result.ok) {
    await recordAuditLogFromRequest(request, {
      action: "storage.media.stream",
      result: result.status === 403 ? "denied" : "failure",
      entityType: "file_object",
      entityId: id,
      entityLabel: asset.filename,
      metadata: { module: asset.module, error: result.error, status: result.status },
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  await recordAuditLogFromRequest(request, {
    action: "storage.media.stream",
    result: "success",
    entityType: "file_object",
    entityId: asset.id,
    entityLabel: asset.filename,
    metadata: {
      module: asset.module,
      access: result.stream.access,
      expiresIn: result.stream.expiresIn,
      seekable: result.stream.seekable,
    },
  })

  if (url.searchParams.get("redirect") === "1") {
    // 302 so the browser's media element follows to the signed/CDN URL. Never
    // cache the redirect itself — the target URL is short-lived per request.
    return NextResponse.redirect(result.stream.url, {
      status: 302,
      headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
    })
  }

  return NextResponse.json(
    { stream: result.stream },
    { headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" } },
  )
}
