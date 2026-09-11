import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getUserMatrix } from "@/lib/permission-store"
import {
  ensureDocumentTypesSchema,
  getDocumentTypes,
  DEFAULT_EXPIRY_WARN_DAYS,
} from "@/lib/hr-documents"

// ---------------------------------------------------------------------------
// HR Master Data → Document Types
//
// Exposes the existing `hr_document_types` master (seeded/managed in
// lib/hr-documents.ts) so HR can configure the Document Type dropdown, mark
// types required, and set per-type expiry behaviour. This is the single source
// of truth already consumed by Employee Documents — no duplicate type system.
// ---------------------------------------------------------------------------

/** Reads are open to any HR user who can see master data; writes need manage. */
async function canManage(userId: number, role: string): Promise<boolean> {
  if (role === "admin") return true
  const matrix = await getUserMatrix(userId)
  const master = matrix?.["hr.master"]
  const docs = matrix?.["hr.documents"]
  const grants = (p?: { add?: string; update?: string; delete?: string }) =>
    !!p && (p.add === "all" || p.update === "all")
  return grants(master) || grants(docs)
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Include inactive so HR can see and re-activate deactivated types.
  const rows = await getDocumentTypes(true)
  return NextResponse.json({ rows })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canManage(session.userId, session.role))) {
    return NextResponse.json({ error: "You do not have permission to manage document types." }, { status: 403 })
  }
  await ensureDocumentTypesSchema()

  const body = await request.json().catch(() => ({}))
  const typeName = String(body.type_name || "").trim()
  if (!typeName) return NextResponse.json({ error: "Document type name is required." }, { status: 400 })

  const isRequired = body.is_required ? 1 : 0
  const hasExpiry = body.has_expiry ? 1 : 0
  const warnDays = Number.isFinite(Number(body.expiry_warn_days))
    ? Math.max(0, Number(body.expiry_warn_days))
    : DEFAULT_EXPIRY_WARN_DAYS
  const status = String(body.status || "Active")

  // Place new types after the current max so ordering stays stable.
  const maxRow = await query<{ m: number }[]>("SELECT COALESCE(MAX(sort_order),0) AS m FROM hr_document_types")
  const sortOrder = Number(maxRow[0]?.m || 0) + 10

  try {
    await query(
      "INSERT INTO hr_document_types (type_name, is_required, has_expiry, expiry_warn_days, status, sort_order) VALUES (?,?,?,?,?,?)",
      [typeName, isRequired, hasExpiry, warnDays, status, sortOrder],
    )
  } catch {
    return NextResponse.json({ error: "A document type with that name already exists." }, { status: 409 })
  }
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canManage(session.userId, session.role))) {
    return NextResponse.json({ error: "You do not have permission to manage document types." }, { status: 403 })
  }
  await ensureDocumentTypesSchema()

  const body = await request.json().catch(() => ({}))
  const id = Number(body.id || 0)
  if (!id) return NextResponse.json({ error: "Document type id is required." }, { status: 400 })

  const existing = await query<any[]>("SELECT * FROM hr_document_types WHERE id = ? LIMIT 1", [id])
  if (!existing.length) return NextResponse.json({ error: "Document type not found." }, { status: 404 })

  const sets: string[] = []
  const args: any[] = []
  if (body.type_name !== undefined) {
    const name = String(body.type_name).trim()
    if (!name) return NextResponse.json({ error: "Document type name cannot be empty." }, { status: 400 })
    // Renaming the type must keep historical documents matching: update the
    // stored document_type string on existing rows too so nothing is orphaned.
    if (name !== existing[0].type_name) {
      await query("UPDATE hr_employee_documents SET document_type = ? WHERE document_type = ?", [
        name,
        existing[0].type_name,
      ])
    }
    sets.push("type_name = ?")
    args.push(name)
  }
  if (body.is_required !== undefined) {
    sets.push("is_required = ?")
    args.push(body.is_required ? 1 : 0)
  }
  if (body.has_expiry !== undefined) {
    sets.push("has_expiry = ?")
    args.push(body.has_expiry ? 1 : 0)
  }
  if (body.expiry_warn_days !== undefined) {
    sets.push("expiry_warn_days = ?")
    args.push(Math.max(0, Number(body.expiry_warn_days) || DEFAULT_EXPIRY_WARN_DAYS))
  }
  if (body.status !== undefined) {
    sets.push("status = ?")
    args.push(String(body.status))
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 })

  try {
    await query(`UPDATE hr_document_types SET ${sets.join(", ")} WHERE id = ?`, [...args, id])
  } catch {
    return NextResponse.json({ error: "A document type with that name already exists." }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canManage(session.userId, session.role))) {
    return NextResponse.json({ error: "You do not have permission to manage document types." }, { status: 403 })
  }
  await ensureDocumentTypesSchema()

  const id = Number(new URL(request.url).searchParams.get("id") || 0)
  if (!id) return NextResponse.json({ error: "Document type id is required." }, { status: 400 })
  const existing = await query<any[]>("SELECT type_name FROM hr_document_types WHERE id = ? LIMIT 1", [id])
  if (!existing.length) return NextResponse.json({ error: "Document type not found." }, { status: 404 })

  // Data integrity: never delete a type that historical documents depend on —
  // deactivate it instead so existing records keep resolving their type.
  const used = await query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM hr_employee_documents WHERE document_type = ?",
    [existing[0].type_name],
  )
  if (Number(used[0]?.c || 0) > 0) {
    await query("UPDATE hr_document_types SET status = 'Inactive' WHERE id = ?", [id])
    return NextResponse.json({ ok: true, deactivated: true })
  }
  await query("DELETE FROM hr_document_types WHERE id = ?", [id])
  return NextResponse.json({ ok: true, deleted: true })
}
