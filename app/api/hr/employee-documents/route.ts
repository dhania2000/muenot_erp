import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { query } from "@/lib/db"
import { validateUpload } from "@/lib/settings/uploads"
import { getUserMatrix } from "@/lib/permission-store"

let columnsEnsured = false

/**
 * Self-healing schema: adds LONGBLOB storage columns so document files live in
 * the database (no external blob storage required). Short-circuits after the
 * first successful call.
 */
async function ensureDocColumns() {
  if (columnsEnsured) return
  const cols = await query<{ COLUMN_NAME: string }[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employee_documents'
       AND COLUMN_NAME IN ('file_data', 'file_mime')`,
  )
  const have = new Set(cols.map((c) => c.COLUMN_NAME))
  if (!have.has("file_data")) await query(`ALTER TABLE hr_employee_documents ADD COLUMN file_data LONGBLOB NULL`)
  if (!have.has("file_mime")) await query(`ALTER TABLE hr_employee_documents ADD COLUMN file_mime VARCHAR(150) NULL`)
  columnsEnsured = true
}

type DocAccess = {
  session: SessionPayload
  /** "all" = admin / HR manager; "self" = employee limited to their own record. */
  scope: "all" | "self"
  employeeId: number | null
  /** Whether this user may upload documents (self-scope respects the matrix). */
  canUpload: boolean
}

/**
 * Resolves what an authenticated user may do with employee documents, driven by
 * the permission matrix (`hr.documents`) with a legacy-grant fallback:
 * - "all": admins and users with `hr.documents` at scope "all" (or the legacy
 *   `hr.manage_employees` grant) manage every employee's documents.
 * - "self": an employee matched to their own hr_employees record may view — and,
 *   when granted add/update on `hr.documents`, upload — only their OWN documents.
 * Returns null when the user has no document access at all.
 */
async function docAccess(): Promise<DocAccess | null> {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") return { session, scope: "all", employeeId: null, canUpload: true }

  const matrix = await getUserMatrix(session.userId)
  const docPerm = matrix?.["hr.documents"]

  // HR-manager level: "all" scope on any document action.
  if (docPerm && (docPerm.view === "all" || docPerm.add === "all" || docPerm.update === "all")) {
    return { session, scope: "all", employeeId: null, canUpload: true }
  }

  // Legacy fallback only when no matrix has ever been configured.
  if (!matrix) {
    const manages = await query<any[]>(
      `SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.manage_employees' LIMIT 1`,
      [session.userId],
    )
    if (manages.length) return { session, scope: "all", employeeId: null, canUpload: true }
  }

  // Self scope: match the login to an employee record by email.
  const me = await query<any[]>(
    "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  if (!me.length) return null

  // With a matrix configured, gate self view/upload by the documents permission.
  // Without a matrix, preserve the legacy behavior (self may view and upload).
  let canView = true
  let canUpload = true
  if (matrix) {
    canView = !!docPerm && (docPerm.view !== "none" || docPerm.add !== "none" || docPerm.update !== "none")
    canUpload = !!docPerm && (docPerm.add !== "none" || docPerm.update !== "none")
  }
  if (!canView) return null
  return { session, scope: "self", employeeId: Number(me[0].id), canUpload }
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

  // Never select the LONGBLOB in list responses — files are streamed separately.
  const docs = await query(
    `SELECT d.id, d.employee_id, d.document_type, d.file_name, d.file_path, d.file_mime,
            d.verified, d.verified_by, d.verified_at, d.status, d.remarks, d.created_at, d.updated_at,
            e.employee_id AS employee_code, e.employee_name, u.name AS verifier_name
     FROM hr_employee_documents d
     JOIN hr_employees e ON e.id=d.employee_id
     LEFT JOIN users u ON u.id=d.verified_by
     ${whereEmployeeId ? "WHERE d.employee_id=?" : ""} ORDER BY d.created_at DESC`,
    whereEmployeeId ? [whereEmployeeId] : [],
  )
  return NextResponse.json({
    documents: docs,
    scope: access.scope,
    selfEmployeeId: access.employeeId,
    canUpload: access.canUpload,
  })
}

export async function POST(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!access.canUpload) {
    return NextResponse.json({ error: "You do not have permission to upload documents." }, { status: 403 })
  }
  await ensureDocColumns()

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
  let fileMime: string | null = null
  let fileData: Buffer | null = null
  if (file instanceof File && file.size > 0) {
    const uploadError = await validateUpload(file)
    if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })
    fileData = Buffer.from(await file.arrayBuffer())
    fileName = file.name
    fileMime = file.type || "application/octet-stream"
    // Stable, unique lookup key used by the file-streaming route (?pathname=).
    filePath = `doc-${crypto.randomUUID()}`
  }

  // Employees can never self-verify or set an approval status — their uploads stay Pending.
  const status = access.scope === "self" ? "Pending" : String(form.get("status") || "Pending")
  await query(
    "INSERT INTO hr_employee_documents (employee_id, document_type, file_name, file_path, file_mime, file_data, status, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [employeeId, type, fileName, filePath, fileMime, fileData, status, String(form.get("remarks") || "") || null],
  )
  return NextResponse.json({ ok: true }, { status: 201 })
}
