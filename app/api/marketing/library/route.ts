import { NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureLibrarySchema,
  canUseLibrary,
  canManageLibrary,
  serializeAsset,
  storageStats,
  nextAssetId,
  recordAudit,
  validateFile,
  sha256Hex,
  suggestAssetType,
  mimeForExtension,
  readImageDimensions,
  parseTags,
  LIBRARY_MAX_BYTES,
} from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SORT_COLUMNS: Record<string, string> = {
  name: "a.name",
  created: "a.created_at",
  updated: "a.updated_at",
  size: "a.file_size",
  usage: "a.usage_count",
  version: "a.current_version",
}

/**
 * GET /api/marketing/library
 * List + search + filter + sort + paginate. `stats=1` also returns storage
 * usage. `picker=1` restricts to selectable (Active, non-archived) assets and
 * is what the reusable Asset Picker uses.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()

  const url = new URL(request.url)
  const p = url.searchParams
  const picker = p.get("picker") === "1"

  const where: string[] = []
  const args: any[] = []

  const q = (p.get("q") || "").trim().toLowerCase()
  if (q) {
    where.push(
      `(LOWER(a.name) LIKE ? OR LOWER(a.file_name) LIKE ? OR LOWER(a.asset_id) LIKE ? OR LOWER(a.asset_type) LIKE ? OR LOWER(COALESCE(a.category,'')) LIKE ? OR LOWER(COALESCE(a.owner_name,'')) LIKE ? OR LOWER(CAST(a.tags AS CHAR)) LIKE ? OR LOWER(COALESCE(f.path,'')) LIKE ?)`,
    )
    const like = `%${q}%`
    args.push(like, like, like, like, like, like, like, like)
  }

  const eqFilters: Array<[string, string]> = [
    ["type", "a.asset_type"],
    ["category", "a.category"],
    ["owner", "a.owner_employee_id"],
  ]
  for (const [param, col] of eqFilters) {
    const v = p.get(param)
    if (v) {
      where.push(`${col} = ?`)
      args.push(v)
    }
  }

  const folder = p.get("folder")
  if (folder) {
    where.push(`a.folder_id = ?`)
    args.push(Number(folder))
  }

  if (picker) {
    where.push(`a.status = 'Active'`)
  } else {
    const status = p.get("status")
    if (status) {
      where.push(`a.status = ?`)
      args.push(status)
    } else if (p.get("includeArchived") !== "1") {
      where.push(`a.status <> 'Archived'`)
    }
  }

  const sizeMin = Number(p.get("sizeMin") || 0)
  if (sizeMin > 0) {
    where.push(`a.file_size >= ?`)
    args.push(sizeMin)
  }
  const dateRanges: Array<[string, string, string]> = [
    ["createdFrom", "a.created_at", ">="],
    ["createdTo", "a.created_at", "<="],
    ["updatedFrom", "a.updated_at", ">="],
    ["updatedTo", "a.updated_at", "<="],
  ]
  for (const [param, col, op] of dateRanges) {
    const v = p.get(param)
    if (v) {
      where.push(`${col} ${op} ?`)
      args.push(op === "<=" ? `${v} 23:59:59` : v)
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const sortKey = SORT_COLUMNS[p.get("sort") || "updated"] || "a.updated_at"
  const dir = (p.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC"
  const page = Math.max(1, Number(p.get("page") || 1))
  const pageSize = Math.min(100, Math.max(1, Number(p.get("pageSize") || 24)))
  const offset = (page - 1) * pageSize

  const [countRow] = (await query(
    `SELECT COUNT(*) AS c FROM marketing_library a LEFT JOIN marketing_library_folders f ON f.id = a.folder_id ${whereSql}`,
    args,
  )) as { c: number }[]

  const rows = (await query(
    `SELECT a.*, f.path AS folder_path
       FROM marketing_library a
       LEFT JOIN marketing_library_folders f ON f.id = a.folder_id
       ${whereSql}
       ORDER BY ${sortKey} ${dir}
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )) as any[]

  const response: any = {
    assets: rows.map(serializeAsset),
    total: Number(countRow?.c || 0),
    page,
    pageSize,
  }
  if (p.get("stats") === "1") response.stats = await storageStats()
  return NextResponse.json(response)
}

/**
 * POST /api/marketing/library  (multipart)
 * Uploads one file as a new asset. Rejects true duplicates by content hash
 * (Phase 19) unless `force=1`. The raw Blob URL is never returned.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()

  const form = await request.formData()
  const file = form.get("file") as File | null
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 })
  if (file.size > LIBRARY_MAX_BYTES)
    return NextResponse.json({ error: `File exceeds ${Math.round(LIBRARY_MAX_BYTES / 1024 / 1024)} MB limit` }, { status: 400 })

  const buffer = await file.arrayBuffer()
  const head = new Uint8Array(buffer.slice(0, 32))
  const check = validateFile(file.name, file.size, head)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  const hash = await sha256Hex(buffer)
  const force = form.get("force") === "1"

  // Duplicate detection by content hash (Phase 19/20).
  const [dup] = (await query(
    `SELECT id, asset_id, name FROM marketing_library WHERE content_hash = ? LIMIT 1`,
    [hash],
  )) as any[]
  if (dup && !force) {
    return NextResponse.json(
      { duplicate: true, existing: { id: Number(dup.id), assetId: dup.asset_id, name: dup.name } },
      { status: 409 },
    )
  }

  const str = (k: string) => {
    const v = form.get(k)
    return v != null && String(v).trim() ? String(v).trim() : null
  }
  const fileType = file.type || mimeForExtension(file.name)
  const dims = readImageDimensions(head.length >= 24 ? new Uint8Array(buffer) : head)
  const tags = parseTags(form.get("tags"))

  let storageUrl: string | null = null
  try {
    const blob = await put(`marketing-library/${crypto.randomUUID()}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: false,
    })
    storageUrl = blob.url
  } catch (err: any) {
    return NextResponse.json(
      { error: "Storage upload failed. Blob storage may not be configured.", detail: String(err?.message || err) },
      { status: 502 },
    )
  }

  const assetId = await nextAssetId()
  const name = str("name") || file.name
  const assetType = str("asset_type") || suggestAssetType(file.name)
  const status = str("status") || "Active"

  const result: any = await query(
    `INSERT INTO marketing_library
      (asset_id, name, file_name, asset_type, category, subcategory, description, tags, folder_id,
       current_version, status, owner_employee_id, owner_name, department, file_size, file_type,
       storage_url, preview_url, content_hash, width, height, expiry_date, usage_rights, copyright,
       license, attribution, restrictions, license_expiry, source, external_ref, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      assetId,
      name,
      file.name,
      assetType,
      str("category"),
      str("subcategory"),
      str("description"),
      JSON.stringify(tags),
      str("folder_id") ? Number(str("folder_id")) : null,
      status,
      str("owner_employee_id"),
      str("owner_name"),
      str("department"),
      file.size,
      fileType,
      storageUrl,
      storageUrl,
      hash,
      dims?.width ?? null,
      dims?.height ?? null,
      str("expiry_date"),
      str("usage_rights"),
      str("copyright"),
      str("license"),
      str("attribution"),
      str("restrictions"),
      str("license_expiry"),
      str("source") || "upload",
      str("external_ref"),
      session.userId,
      session.name,
    ],
  )
  const libraryId = Number(result.insertId)

  await query(
    `INSERT INTO marketing_library_versions
      (library_id, version, file_name, file_type, file_size, storage_url, content_hash, width, height, change_note, uploaded_by, uploaded_by_name)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?)`,
    [
      libraryId,
      file.name,
      fileType,
      file.size,
      storageUrl,
      hash,
      dims?.width ?? null,
      dims?.height ?? null,
      str("change_note") || "Initial upload",
      session.userId,
      session.name,
    ],
  )

  await recordAudit("uploaded", {
    libraryId,
    assetCode: assetId,
    detail: name,
    userId: session.userId,
    userName: session.name,
  })

  const [row] = (await query(`SELECT * FROM marketing_library WHERE id = ?`, [libraryId])) as any[]
  return NextResponse.json({ asset: serializeAsset(row) }, { status: 201 })
}
