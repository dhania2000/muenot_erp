import { put } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { validateUpload } from "@/lib/settings/uploads"

type DocAccess =
  | { session: SessionPayload; scope: "all"; employeeId: null }
  | { session: SessionPayload; scope: "self"; employeeId: number }

/**
 * Resolves what an authenticated user may do with employee documents.
 * - "all": admins and HR managers (hr.manage_employees) can view every employee's
 *   documents and upload/verify on their behalf.
 * - "self": a regular employee (matched to their own hr_employees record by email)
 *   may only view and upload their OWN documents.
 * Returns null when the user has no document access at all.
 */
async function docAccess(): Promise<DocAccess | null> {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") return { session, scope: "all", employeeId: null }
  const manages = await query<any[]>(
    `SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.manage_employees' LIMIT 1`,
    [session.userId],
  )
  if (manages.length) return { session, scope: "all", employeeId: null }
  // A regular employee may manage only their OWN documents, and only when they
  // have been granted the "Employee Documents" permission.
  const canManageOwn = await userHasFeature(session.userId, session.role, "hr.view_documents")
  if (!canManageOwn) return null
  const me = await query<any[]>(
    "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  if (!me.length) return null
  return { session, scope: "self", employeeId: Number(me[0].id) }
}

export async function GET(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Self-scope users are always locked to their own employee id, ignoring any
  // employee_id supplied on the query string.
  let whereEmployeeId: number | null = null
  if (access.scope === "self") {
    whereEmployeeId = access.employeeId
  } else {
    const param = new URL(request.url).searchParams.get("employee_id")
    if (param) whereEmployeeId = Number(param)
  }

  const docs = await query(
    `SELECT d.*, e.employee_id AS employee_code, e.employee_name, u.name AS verifier_name FROM hr_employee_documents d JOIN hr_employees e ON e.id=d.employee_id LEFT JOIN users u ON u.id=d.verified_by ${whereEmployeeId ? "WHERE d.employee_id=?" : ""} ORDER BY d.created_at DESC`,
    whereEmployeeId ? [whereEmployeeId] : [],
  )
  return NextResponse.json({ documents: docs, scope: access.scope, selfEmployeeId: access.employeeId })
}

export async function POST(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const form = await request.formData()
  // Self-scope employees can only ever upload against their own record.
  const employeeId = access.scope === "self" ? String(access.employeeId) : String(form.get("employee_id") || "")
  const type = String(form.get("document_type") || "")
  const file = form.get("file")
  if (!employeeId || !type) return NextResponse.json({ error: "Employee and document type are required" }, { status: 400 })

  // Employees may upload but never overwrite: block a second file for a document
  // type they already have. Only HR/admins can replace documents.
  if (access.scope === "self") {
    const existing = await query<any[]>(
      "SELECT id FROM hr_employee_documents WHERE employee_id=? AND document_type=? LIMIT 1",
      [employeeId, type],
    )
    if (existing.length) {
      return NextResponse.json(
        { error: "You have already uploaded this document type. It cannot be overwritten — contact HR to replace it." },
        { status: 409 },
      )
    }
  }

  let fileName: string | null = null
  let filePath: string | null = null
  if (file instanceof File && file.size > 0) {
    const uploadError = await validateUpload(file)
    if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })
    const blob = await put(`hr-documents/${employeeId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, file, { access: "public", addRandomSuffix: false })
    fileName = file.name
    filePath = blob.url
  }

  // Employees can never self-verify or set an approval status — their uploads stay Pending.
  const status = access.scope === "self" ? "Pending" : String(form.get("status") || "Pending")
  await query(
    "INSERT INTO hr_employee_documents (employee_id, document_type, file_name, file_path, status, remarks) VALUES (?, ?, ?, ?, ?, ?)",
    [employeeId, type, fileName, filePath, status, String(form.get("remarks") || "") || null],
  )
  return NextResponse.json({ ok: true }, { status: 201 })
}
