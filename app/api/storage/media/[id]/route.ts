import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getMediaAsset, purgeMediaAsset } from "@/lib/storage/media"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { canDeleteMediaModule, canViewMediaModule } from "../_access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** GET /api/storage/media/[id] — one media asset's metadata (tenant-scoped). */
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

  return NextResponse.json({ asset })
}

/**
 * DELETE /api/storage/media/[id] — purge the media object and metadata.
 * Idempotent: an already-purged asset returns 404. Honours legal hold (409).
 * Every attempt is audited with success/failure.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const asset = await getMediaAsset(id)
  if (!asset) return NextResponse.json({ error: "Media asset not found" }, { status: 404 })
  if (!(await canDeleteMediaModule(session, asset.module))) {
    await recordAuditLogFromRequest(request, {
      action: "storage.media.purge",
      result: "denied",
      entityType: "file_object",
      entityId: asset.id,
      entityLabel: asset.filename,
      metadata: { module: asset.module, reason: "forbidden" },
    })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const result = await purgeMediaAsset(id)
  if (!result.ok) {
    await recordAuditLogFromRequest(request, {
      action: "storage.media.purge",
      result: "failure",
      entityType: "file_object",
      entityId: id,
      entityLabel: asset.filename,
      metadata: { module: asset.module, error: result.error, status: result.status },
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  await recordAuditLogFromRequest(request, {
    action: "storage.media.purge",
    result: "success",
    entityType: "file_object",
    entityId: asset.id,
    entityLabel: asset.filename,
    metadata: { module: asset.module, objectKey: asset.objectKey },
  })

  return NextResponse.json({ ok: true, purged: asset.id })
}
