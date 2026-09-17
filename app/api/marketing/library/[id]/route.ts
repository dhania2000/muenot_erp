import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureLibrarySchema,
  canUseLibrary,
  canManageLibrary,
  serializeAsset,
  recordAudit,
  parseTags,
} from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function loadAsset(id: number) {
  const [row] = (await query(
    `SELECT a.*, f.path AS folder_path FROM marketing_library a
       LEFT JOIN marketing_library_folders f ON f.id = a.folder_id WHERE a.id = ?`,
    [id],
  )) as any[]
  return row || null
}

/** GET /api/marketing/library/[id] — full detail incl. versions, usage, audit. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const row = await loadAsset(Number(id))
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [versions, usage, audit] = await Promise.all([
    query(
      `SELECT id, version, file_name, file_type, file_size, width, height, change_note, uploaded_by_name, uploaded_at
         FROM marketing_library_versions WHERE library_id = ? ORDER BY version DESC`,
      [row.id],
    ),
    query(
      `SELECT id, module, ref_id, ref_label, created_at FROM marketing_library_usage WHERE library_id = ? ORDER BY created_at DESC`,
      [row.id],
    ),
    query(
      `SELECT action, detail, user_name, created_at FROM marketing_library_audit WHERE library_id = ? ORDER BY created_at DESC LIMIT 100`,
      [row.id],
    ),
  ])

  return NextResponse.json({
    asset: serializeAsset(row),
    versions,
    usage,
    audit,
  })
}

/** PATCH /api/marketing/library/[id] — update metadata / status / folder / tags. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const row = await loadAsset(Number(id))
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const editable: Record<string, string> = {
    name: "name",
    assetType: "asset_type",
    category: "category",
    subcategory: "subcategory",
    description: "description",
    status: "status",
    ownerEmployeeId: "owner_employee_id",
    ownerName: "owner_name",
    department: "department",
    expiryDate: "expiry_date",
    usageRights: "usage_rights",
    copyright: "copyright",
    license: "license",
    attribution: "attribution",
    restrictions: "restrictions",
    licenseExpiry: "license_expiry",
  }
  const sets: string[] = []
  const args: any[] = []
  for (const [key, col] of Object.entries(editable)) {
    if (key in body) {
      sets.push(`${col} = ?`)
      args.push(body[key] === "" ? null : body[key])
    }
  }
  if ("folderId" in body) {
    sets.push(`folder_id = ?`)
    args.push(body.folderId != null ? Number(body.folderId) : null)
  }
  if ("tags" in body) {
    sets.push(`tags = ?`)
    args.push(JSON.stringify(parseTags(body.tags)))
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  await query(`UPDATE marketing_library SET ${sets.join(", ")} WHERE id = ?`, [...args, row.id])

  // Audit the meaningful transitions distinctly (Phase 84).
  let action = "updated"
  if ("status" in body && body.status === "Archived") action = "archived"
  else if ("folderId" in body) action = "moved"
  else if ("tags" in body) action = "tagged"
  await recordAudit(action, {
    libraryId: row.id,
    assetCode: row.asset_id,
    detail: "status" in body ? `status=${body.status}` : null,
    userId: session.userId,
    userName: session.name,
  })

  const updated = await loadAsset(row.id)
  return NextResponse.json({ asset: serializeAsset(updated) })
}

/**
 * DELETE /api/marketing/library/[id]
 * Safe delete (Phase 65-67). Refuses to hard-delete an asset with active
 * references unless `?force=1` AND the asset is archived first. Prefers archive.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const row = await loadAsset(Number(id))
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const url = new URL(request.url)
  const force = url.searchParams.get("force") === "1"

  const [usageRow] = (await query(
    `SELECT COUNT(*) AS c FROM marketing_library_usage WHERE library_id = ?`,
    [row.id],
  )) as { c: number }[]
  const refCount = Number(usageRow?.c || 0)

  if (refCount > 0 && !force) {
    const usage = await query(
      `SELECT module, ref_id, ref_label FROM marketing_library_usage WHERE library_id = ? LIMIT 50`,
      [row.id],
    )
    return NextResponse.json(
      {
        blocked: true,
        reason: "Asset is referenced by other modules. Archive it or confirm forced delete.",
        refCount,
        usage,
      },
      { status: 409 },
    )
  }

  await query(`DELETE FROM marketing_library_versions WHERE library_id = ?`, [row.id])
  await query(`DELETE FROM marketing_library_usage WHERE library_id = ?`, [row.id])
  await query(`DELETE FROM marketing_library WHERE id = ?`, [row.id])
  await recordAudit("deleted", {
    libraryId: null,
    assetCode: row.asset_id,
    detail: `${row.name} (forced=${force}, refs=${refCount})`,
    userId: session.userId,
    userName: session.name,
  })
  return NextResponse.json({ ok: true })
}
