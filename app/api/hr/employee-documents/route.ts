import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { query } from "@/lib/db"
import { validateUpload } from "@/lib/settings/uploads"
import { getUserMatrix } from "@/lib/permission-store"
import { nextRecordId } from "@/lib/record-ids"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureEmployeeDocumentsSchema,
  getDocumentTypes,
  expiryStatus,
  type DocumentType,
} from "@/lib/hr-documents"

type DocAccess = {
  session: SessionPayload
  /** "all" = admin / HR manager; "self" = employee limited to their own record. */
  scope: "all" | "self"
  employeeId: number | null
  /** Whether this user may upload documents. */
  canUpload: boolean
  /** Whether this user may verify / reject / archive / restore documents. */
  canManage: boolean
  /** Whether this user may permanently delete (highest privilege). */
  canDelete: boolean
}

/**
 * Resolves what an authenticated user may do with employee documents, driven by
 * the permission matrix (`hr.documents`) with a legacy-grant fallback. HR/admin
 * ("all" scope) manage every employee's documents; a matched employee ("self")
 * may view and, when granted, upload only their OWN documents.
 */
async function docAccess(): Promise<DocAccess | null> {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") {
    return { session, scope: "all", employeeId: null, canUpload: true, canManage: true, canDelete: true }
  }

  const matrix = await getUserMatrix(session.userId)
  const docPerm = matrix?.["hr.documents"]

  // HR-manager level: "all" scope on any document action.
  if (docPerm && (docPerm.view === "all" || docPerm.add === "all" || docPerm.update === "all")) {
    return {
      session,
      scope: "all",
      employeeId: null,
      canUpload: docPerm.add !== "none" || docPerm.update !== "none",
      canManage: docPerm.update === "all",
      canDelete: docPerm.delete === "all",
    }
  }

  // Legacy fallback only when no matrix has ever been configured.
  if (!matrix) {
    const manages = await query<any[]>(
      `SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.manage_employees' LIMIT 1`,
      [session.userId],
    )
    if (manages.length) {
      return { session, scope: "all", employeeId: null, canUpload: true, canManage: true, canDelete: false }
    }
  }

  // Self scope: match the login to an employee record by email.
  const me = await query<any[]>(
    "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  if (!me.length) return null

  let canView = true
  let canUpload = true
  if (matrix) {
    canView = !!docPerm && (docPerm.view !== "none" || docPerm.add !== "none" || docPerm.update !== "none")
    canUpload = !!docPerm && (docPerm.add !== "none" || docPerm.update !== "none")
  }
  if (!canView) return null
  return { session, scope: "self", employeeId: Number(me[0].id), canUpload, canManage: false, canDelete: false }
}

/** Attach the per-type expiry classification using each type's warn window. */
function withExpiry(rows: any[], types: DocumentType[]) {
  const warnByName = new Map(types.map((t) => [t.type_name, t.expiry_warn_days]))
  return rows.map((r) => ({
    ...r,
    expiry_status: expiryStatus(r.expiry_date, warnByName.get(r.document_type)),
  }))
}

async function logDoc(
  access: DocAccess,
  doc: { id: number; employee_id: number; document_type: string; document_ref?: string | null },
  type: Parameters<typeof logEmployeeEvent>[0]["type"],
  summary: string,
  changes?: { field: string; label: string; from: unknown; to: unknown }[],
) {
  const emp = await query<any[]>(
    "SELECT employee_id, employee_name FROM hr_employees WHERE id = ? LIMIT 1",
    [doc.employee_id],
  ).catch(() => [])
  await logEmployeeEvent({
    employeeId: doc.employee_id,
    employeeRef: emp[0]?.employee_id ?? null,
    employeeName: emp[0]?.employee_name ?? null,
    type,
    summary,
    changes: changes ?? null,
    actorId: access.session.userId,
    actorName: access.session.name,
  })
}

export async function GET(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeDocumentsSchema()
  const types = await getDocumentTypes()

  const sp = new URL(request.url).searchParams
  const where: string[] = []
  const args: any[] = []

  // Self-scope users are always locked to their own employee id.
  if (access.scope === "self") {
    where.push("d.employee_id = ?")
    args.push(access.employeeId)
  } else if (sp.get("employee_id")) {
    where.push("d.employee_id = ?")
    args.push(Number(sp.get("employee_id")))
  }

  // Active (current, not archived) is the default view; archived/all are opt-in.
  const view = sp.get("view") || "active"
  if (view === "active") where.push("d.archived_at IS NULL")
  else if (view === "archived") where.push("d.archived_at IS NOT NULL")

  // Only latest versions by default; ?versions=all surfaces the full history.
  if (sp.get("versions") !== "all") where.push("d.is_current = 1")

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      "(e.employee_name LIKE ? OR e.employee_id LIKE ? OR d.document_ref LIKE ? OR d.document_number LIKE ? OR d.document_type LIKE ?)",
    )
    args.push(like, like, like, like, like)
  }
  for (const [param, col] of [
    ["department", "e.department"],
    ["designation", "e.designation"],
    ["document_type", "d.document_type"],
    ["status", "d.status"],
  ] as const) {
    const v = sp.get(param)
    if (v) {
      where.push(`${col} = ?`)
      args.push(v)
    }
  }
  const uploadedFrom = sp.get("uploaded_from")
  const uploadedTo = sp.get("uploaded_to")
  if (uploadedFrom) {
    where.push("d.created_at >= ?")
    args.push(uploadedFrom)
  }
  if (uploadedTo) {
    where.push("d.created_at <= ?")
    args.push(`${uploadedTo} 23:59:59`)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  // Never select the LONGBLOB in list responses — files are streamed separately.
  const rows = await query<any[]>(
    `SELECT d.id, d.employee_id, d.document_ref, d.document_type, d.document_number,
            d.issue_date, d.expiry_date, d.version, d.is_current, d.supersedes_id,
            d.file_name, d.file_path, d.file_mime, d.verified, d.verified_by, d.verified_at,
            d.rejection_reason, d.rejected_by, d.rejected_at, d.archived_at, d.archived_by,
            d.uploaded_by, d.status, d.remarks, d.created_at, d.updated_at,
            e.employee_id AS employee_code, e.employee_name, e.department, e.designation,
            uv.name AS verifier_name, uu.name AS uploader_name
       FROM hr_employee_documents d
       JOIN hr_employees e ON e.id = d.employee_id
       LEFT JOIN users uv ON uv.id = d.verified_by
       LEFT JOIN users uu ON uu.id = d.uploaded_by
       ${whereSql}
       ORDER BY d.created_at DESC`,
    args,
  )
  const documents = withExpiry(rows, types)

  // Expiry-status filter is computed, so it's applied after classification.
  const expiryFilter = sp.get("expiry")
  const filtered = expiryFilter ? documents.filter((d) => d.expiry_status === expiryFilter) : documents

  // Compliance summary over the active current documents in scope.
  const summary = {
    total: filtered.length,
    verified: filtered.filter((d) => d.status === "Verified").length,
    pending: filtered.filter((d) => d.status === "Pending" || d.status === "Pending Verification").length,
    rejected: filtered.filter((d) => d.status === "Rejected").length,
    expiringSoon: filtered.filter((d) => d.expiry_status === "Expiring Soon").length,
    expired: filtered.filter((d) => d.expiry_status === "Expired").length,
    missingRequired: 0,
  }

  // Required-document checklist for a single employee (dynamic — derived from the
  // document-types master, so it applies to every employee incl. new hires with
  // no per-row seeding and never touches the Add Employee flow).
  let checklist: { type: string; required: boolean; uploaded: boolean; verified: boolean }[] | null = null
  const forEmployee = access.scope === "self" ? access.employeeId : sp.get("employee_id") ? Number(sp.get("employee_id")) : null
  if (forEmployee) {
    const current = documents.filter((d) => d.employee_id === forEmployee)
    checklist = types
      .filter((t) => t.is_required === 1)
      .map((t) => {
        const doc = current.find((d) => d.document_type === t.type_name)
        return {
          type: t.type_name,
          required: true,
          uploaded: !!doc,
          verified: !!doc && doc.status === "Verified",
        }
      })
    summary.missingRequired = checklist.filter((c) => !c.uploaded).length
  }

  return NextResponse.json({
    documents: filtered,
    documentTypes: types,
    summary,
    checklist,
    scope: access.scope,
    selfEmployeeId: access.employeeId,
    canUpload: access.canUpload,
    canManage: access.canManage,
    canDelete: access.canDelete,
  })
}

export async function POST(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!access.canUpload) {
    return NextResponse.json({ error: "You do not have permission to upload documents." }, { status: 403 })
  }
  await ensureEmployeeDocumentsSchema()

  const form = await request.formData()
  const employeeId = access.scope === "self" ? Number(access.employeeId) : Number(form.get("employee_id") || 0)
  const type = String(form.get("document_type") || "").trim()
  const file = form.get("file")
  const replaceOf = form.get("replace_of") ? Number(form.get("replace_of")) : null
  if (!employeeId || !type) {
    return NextResponse.json({ error: "Employee and document type are required" }, { status: 400 })
  }

  // Employees may upload but never overwrite/replace — only HR/admins version.
  if (access.scope === "self") {
    const existing = await query<any[]>(
      "SELECT id FROM hr_employee_documents WHERE employee_id=? AND document_type=? AND is_current=1 AND archived_at IS NULL LIMIT 1",
      [employeeId, type],
    )
    if (existing.length) {
      return NextResponse.json(
        { error: "You have already uploaded this document type. Contact HR to replace it." },
        { status: 409 },
      )
    }
  }

  // File handling — validated against the configured type/size limits and stored
  // under an opaque UUID key (never the original filename) in the DB LONGBLOB.
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
    filePath = `doc-${crypto.randomUUID()}`
  }

  // Versioning: a new file for a type the employee already has supersedes the
  // previous current version rather than destroying it.
  const prior = await query<any[]>(
    "SELECT id, version FROM hr_employee_documents WHERE employee_id=? AND document_type=? AND is_current=1 AND archived_at IS NULL ORDER BY version DESC LIMIT 1",
    [employeeId, type],
  )
  const supersedes = prior[0] || null
  const version = supersedes ? Number(supersedes.version) + 1 : 1

  const documentRef = await nextRecordId("DOC", { digits: 6 })
  const status = access.scope === "self" ? "Pending" : String(form.get("status") || "Pending")
  const documentNumber = String(form.get("document_number") || "").trim() || null
  const issueDate = String(form.get("issue_date") || "").trim() || null
  const expiryDate = String(form.get("expiry_date") || "").trim() || null

  if (supersedes) {
    await query("UPDATE hr_employee_documents SET is_current = 0 WHERE id = ?", [supersedes.id])
  }

  const result = await query<any>(
    `INSERT INTO hr_employee_documents
       (employee_id, document_ref, document_type, document_number, issue_date, expiry_date,
        version, is_current, supersedes_id, file_name, file_path, file_mime, file_data,
        uploaded_by, status, remarks)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,
    [
      employeeId,
      documentRef,
      type,
      documentNumber,
      issueDate,
      expiryDate,
      version,
      supersedes?.id ?? null,
      fileName,
      filePath,
      fileMime,
      fileData,
      access.session.userId,
      status,
      String(form.get("remarks") || "") || null,
    ],
  )

  const newId = Number(result.insertId)
  const isReplace = !!supersedes || !!replaceOf
  await logDoc(
    access,
    { id: newId, employee_id: employeeId, document_type: type, document_ref: documentRef },
    isReplace ? "document_replaced" : "document_uploaded",
    isReplace
      ? `${type} replaced — version ${version} (${documentRef}) is now current`
      : `${type} uploaded (${documentRef})`,
  )

  return NextResponse.json({ ok: true, id: newId, document_ref: documentRef, version }, { status: 201 })
}

export async function PATCH(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!access.canManage) {
    return NextResponse.json({ error: "You do not have permission to manage documents." }, { status: 403 })
  }
  await ensureEmployeeDocumentsSchema()

  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")
  const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : body.id ? [Number(body.id)] : []
  if (!ids.length) return NextResponse.json({ error: "No document selected" }, { status: 400 })

  const rows = await query<any[]>(
    `SELECT id, employee_id, document_type, document_ref, status FROM hr_employee_documents WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  )
  if (!rows.length) return NextResponse.json({ error: "Document not found" }, { status: 404 })
  const uid = access.session.userId

  for (const doc of rows) {
    if (action === "verify") {
      await query(
        "UPDATE hr_employee_documents SET verified=1, status='Verified', verified_by=?, verified_at=NOW(), rejection_reason=NULL, rejected_by=NULL, rejected_at=NULL WHERE id=?",
        [uid, doc.id],
      )
      await logDoc(access, doc, "document_verified", `${doc.document_type} verified (${doc.document_ref})`, [
        { field: "status", label: "Status", from: doc.status, to: "Verified" },
      ])
    } else if (action === "reject") {
      const reason = String(body.reason || "").trim()
      if (!reason) return NextResponse.json({ error: "A rejection reason is required." }, { status: 400 })
      await query(
        "UPDATE hr_employee_documents SET verified=0, status='Rejected', rejected_by=?, rejected_at=NOW(), rejection_reason=? WHERE id=?",
        [uid, reason, doc.id],
      )
      await logDoc(access, doc, "document_rejected", `${doc.document_type} rejected (${doc.document_ref}): ${reason}`, [
        { field: "status", label: "Status", from: doc.status, to: "Rejected" },
        { field: "rejection_reason", label: "Rejection reason", from: null, to: reason },
      ])
    } else if (action === "archive") {
      await query("UPDATE hr_employee_documents SET archived_at=NOW(), archived_by=? WHERE id=?", [uid, doc.id])
      await logDoc(access, doc, "document_archived", `${doc.document_type} archived (${doc.document_ref})`)
    } else if (action === "restore") {
      await query("UPDATE hr_employee_documents SET archived_at=NULL, archived_by=NULL WHERE id=?", [doc.id])
      await logDoc(access, doc, "document_restored", `${doc.document_type} restored (${doc.document_ref})`)
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
  }

  return NextResponse.json({ ok: true, affected: rows.length })
}

export async function DELETE(request: Request) {
  const access = await docAccess()
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!access.canDelete) {
    return NextResponse.json({ error: "Permanent deletion requires the highest document permission." }, { status: 403 })
  }
  await ensureEmployeeDocumentsSchema()

  const id = Number(new URL(request.url).searchParams.get("id") || 0)
  if (!id) return NextResponse.json({ error: "Document id is required" }, { status: 400 })
  const rows = await query<any[]>(
    "SELECT id, employee_id, document_type, document_ref FROM hr_employee_documents WHERE id = ? LIMIT 1",
    [id],
  )
  if (!rows.length) return NextResponse.json({ error: "Document not found" }, { status: 404 })

  await query("DELETE FROM hr_employee_documents WHERE id = ?", [id])
  await logDoc(access, rows[0], "document_deleted", `${rows[0].document_type} permanently deleted (${rows[0].document_ref})`)
  return NextResponse.json({ ok: true })
}
