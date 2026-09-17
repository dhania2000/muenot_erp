import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureLibrarySchema,
  canUseLibrary,
  recordAudit,
  USAGE_MODULES,
  type UsageModule,
} from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Shared reference API (Phase 45-47/63). Other modules call this to LINK an
 * existing Library asset to one of their records instead of duplicating the
 * file. Links drive the asset's usage count and "Used By" list.
 *
 * POST   { assetId, module, refId, refLabel? }  -> link
 * DELETE ?assetId=&module=&refId=               -> unlink
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()

  const body = await request.json().catch(() => ({}))
  const assetId = String(body.assetId || "").trim()
  const module = String(body.module || "").trim() as UsageModule
  const refId = String(body.refId || "").trim()
  const refLabel = body.refLabel ? String(body.refLabel).slice(0, 255) : null
  if (!assetId || !refId || !USAGE_MODULES.includes(module))
    return NextResponse.json({ error: "assetId, module and refId are required" }, { status: 400 })

  const [asset] = (await query(
    `SELECT id, asset_id, name, status FROM marketing_library WHERE asset_id = ?`,
    [assetId],
  )) as any[]
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
  if (asset.status === "Archived")
    return NextResponse.json({ error: "Asset is archived and cannot be newly referenced" }, { status: 409 })

  const result: any = await query(
    `INSERT IGNORE INTO marketing_library_usage (library_id, module, ref_id, ref_label, created_by)
     VALUES (?,?,?,?,?)`,
    [asset.id, module, refId, refLabel, session.userId],
  )
  if (result.affectedRows > 0) {
    await query(`UPDATE marketing_library SET usage_count = usage_count + 1 WHERE id = ?`, [asset.id])
    await recordAudit("referenced", {
      libraryId: asset.id,
      assetCode: asset.asset_id,
      detail: `${module}:${refId}`,
      userId: session.userId,
      userName: session.name,
    })
  }
  return NextResponse.json({ ok: true, assetId: asset.asset_id })
}

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()

  const url = new URL(request.url)
  const assetId = String(url.searchParams.get("assetId") || "").trim()
  const module = String(url.searchParams.get("module") || "").trim()
  const refId = String(url.searchParams.get("refId") || "").trim()
  if (!assetId || !module || !refId)
    return NextResponse.json({ error: "assetId, module and refId are required" }, { status: 400 })

  const [asset] = (await query(`SELECT id FROM marketing_library WHERE asset_id = ?`, [assetId])) as any[]
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })

  const result: any = await query(
    `DELETE FROM marketing_library_usage WHERE library_id = ? AND module = ? AND ref_id = ?`,
    [asset.id, module, refId],
  )
  if (result.affectedRows > 0) {
    await query(
      `UPDATE marketing_library SET usage_count = GREATEST(usage_count - 1, 0) WHERE id = ?`,
      [asset.id],
    )
  }
  return NextResponse.json({ ok: true })
}
