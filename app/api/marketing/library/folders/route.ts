import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureLibrarySchema, canUseLibrary, canManageLibrary, recordAudit } from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET — folder tree with per-folder asset counts (Phase 10/11). */
export async function GET() {
  const session = await getSession()
  if (!session || !(await canUseLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const folders = (await query(
    `SELECT f.id, f.name, f.parent_id, f.path, f.restricted, f.allowed_roles,
            (SELECT COUNT(*) FROM marketing_library a WHERE a.folder_id = f.id AND a.status <> 'Archived') AS asset_count
       FROM marketing_library_folders f
       ORDER BY f.path ASC`,
  )) as any[]

  // Hide restricted folders from non-admins lacking the role (Phase 12/62).
  const visible = folders.filter((f) => {
    if (!f.restricted || session.role === "admin") return true
    const roles: string[] = Array.isArray(f.allowed_roles) ? f.allowed_roles : []
    return roles.length === 0 || roles.includes(session.role)
  })
  return NextResponse.json({ folders: visible })
}

/** POST — create a folder, optionally nested under `parentId` (Phase 11/12). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManageLibrary(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureLibrarySchema()
  const body = await request.json().catch(() => ({}))
  const name = String(body.name || "").trim()
  if (!name) return NextResponse.json({ error: "Folder name required" }, { status: 400 })

  const parentId = body.parentId != null ? Number(body.parentId) : null
  let path = name
  if (parentId) {
    const [parent] = (await query(
      `SELECT path FROM marketing_library_folders WHERE id = ?`,
      [parentId],
    )) as any[]
    if (!parent) return NextResponse.json({ error: "Parent folder not found" }, { status: 404 })
    path = `${parent.path} / ${name}`
  }

  const restricted = body.restricted ? 1 : 0
  const allowedRoles = Array.isArray(body.allowedRoles) ? body.allowedRoles : null

  const result: any = await query(
    `INSERT INTO marketing_library_folders (name, parent_id, path, restricted, allowed_roles, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?)`,
    [name, parentId, path, restricted, allowedRoles ? JSON.stringify(allowedRoles) : null, session.userId, session.name],
  )
  await recordAudit("folder_created", {
    detail: path,
    userId: session.userId,
    userName: session.name,
  })
  return NextResponse.json({ folder: { id: Number(result.insertId), name, parent_id: parentId, path } }, { status: 201 })
}
