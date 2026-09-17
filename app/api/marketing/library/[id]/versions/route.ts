import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureLibrarySchema,
  canUseLibrary,
  canManageLibrary,
  serializeAsset,
  recordAudit,
  validateFile,
  sha256Hex,
  mimeForExtension,
  readImageDimensions,
  LIBRARY_MAX_BYTES,
} from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET — version history (Phase 24). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const versions = await query(
    `SELECT id, version, file_name, file_type, file_size, width, height, change_note, uploaded_by_name, uploaded_at
       FROM marketing_library_versions WHERE library_id = ? ORDER BY version DESC`,
    [Number(id)],
  )
  return NextResponse.json({ versions })
}

/**
 * POST — upload a new version of an existing asset (Phase 22). The previous
 * version is preserved; the master row is repointed to the new current version.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const [asset] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [Number(id)])) as any[]
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const form = await request.formData()
  const file = form.get("file") as File | null
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 })
  if (file.size > LIBRARY_MAX_BYTES)
    return NextResponse.json({ error: "File exceeds size limit" }, { status: 400 })

  const buffer = await file.arrayBuffer()
  const head = new Uint8Array(buffer.slice(0, 32))
  const check = validateFile(file.name, file.size, head)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  const hash = await sha256Hex(buffer)
  const fileType = file.type || mimeForExtension(file.name)
  const dims = readImageDimensions(new Uint8Array(buffer))
  const changeNote = String(form.get("change_note") || "").slice(0, 500) || "New version"

  // File bytes are stored directly in MySQL (no external Blob storage).
  const fileData = Buffer.from(buffer)
  const storageUrl: string | null = null

  const nextVersion = Number(asset.current_version || 1) + 1
  await query(
    `INSERT INTO marketing_library_versions
      (library_id, version, file_name, file_type, file_size, storage_url, file_data, content_hash, width, height, change_note, uploaded_by, uploaded_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      asset.id,
      nextVersion,
      file.name,
      fileType,
      file.size,
      storageUrl,
      fileData,
      hash,
      dims?.width ?? null,
      dims?.height ?? null,
      changeNote,
      session.userId,
      session.name,
    ],
  )
  await query(
    `UPDATE marketing_library
        SET current_version = ?, file_name = ?, file_type = ?, file_size = ?, storage_url = ?,
            preview_url = ?, content_hash = ?, width = ?, height = ?
      WHERE id = ?`,
    [
      nextVersion,
      file.name,
      fileType,
      file.size,
      storageUrl,
      storageUrl,
      hash,
      dims?.width ?? null,
      dims?.height ?? null,
      asset.id,
    ],
  )
  await recordAudit("version_created", {
    libraryId: asset.id,
    assetCode: asset.asset_id,
    detail: `v${nextVersion}: ${changeNote}`,
    userId: session.userId,
    userName: session.name,
  })

  const [row] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [asset.id])) as any[]
  return NextResponse.json({ asset: serializeAsset(row) }, { status: 201 })
}

/**
 * PATCH — restore a previous version as current (Phase 25). Restoring copies the
 * chosen version's file into a NEW version so history is never destroyed.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const targetVersion = Number(body.version)
  if (!targetVersion) return NextResponse.json({ error: "version required" }, { status: 400 })

  const [asset] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [Number(id)])) as any[]
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const [target] = (await query(
    `SELECT * FROM marketing_library_versions WHERE library_id = ? AND version = ?`,
    [asset.id, targetVersion],
  )) as any[]
  if (!target) return NextResponse.json({ error: "Version not found" }, { status: 404 })

  const nextVersion = Number(asset.current_version || 1) + 1
  await query(
    `INSERT INTO marketing_library_versions
      (library_id, version, file_name, file_type, file_size, storage_url, file_data, content_hash, width, height, change_note, uploaded_by, uploaded_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      asset.id,
      nextVersion,
      target.file_name,
      target.file_type,
      target.file_size,
      target.storage_url,
      target.file_data,
      target.content_hash,
      target.width,
      target.height,
      `Restored from v${targetVersion}`,
      session.userId,
      session.name,
    ],
  )
  await query(
    `UPDATE marketing_library
        SET current_version = ?, file_name = ?, file_type = ?, file_size = ?, storage_url = ?,
            preview_url = ?, content_hash = ?, width = ?, height = ?
      WHERE id = ?`,
    [
      nextVersion,
      target.file_name,
      target.file_type,
      target.file_size,
      target.storage_url,
      target.storage_url,
      target.content_hash,
      target.width,
      target.height,
      asset.id,
    ],
  )
  await recordAudit("restored", {
    libraryId: asset.id,
    assetCode: asset.asset_id,
    detail: `Restored v${targetVersion} as v${nextVersion}`,
    userId: session.userId,
    userName: session.name,
  })

  const [row] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [asset.id])) as any[]
  return NextResponse.json({ asset: serializeAsset(row) })
}
