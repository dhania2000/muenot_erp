import { NextRequest, NextResponse } from "next/server"
import { pool, query } from "@/lib/db"
import { getSession, type SessionPayload } from "@/lib/auth"
import {
  MASTER_CONFIGS,
  type MasterKind,
  ensureHrMasterSchema,
  canManageMaster,
  canViewSensitive,
  nextVarcharId,
  formatAutoCode,
  validateRefs,
  wouldCreateCycle,
  getDependencies,
  writeMasterAudit,
} from "@/lib/hr-master-data"

// ---------------------------------------------------------------------------
// HR Master Data API — domain-specific, server-authoritative.
//
// Replaces the previous generic "accept any field and INSERT" handler. Every
// mutation now:
//   - requires a session, and manage permission for writes (server-side RBAC)
//   - generates IDs / display codes server-side (never trusts client IDs)
//   - validates cross-master references before writing
//   - prevents circular Department / Designation hierarchies
//   - refuses hard deletes when dependencies exist (deactivate instead)
//   - records an audit entry for create / update / deactivate / delete
//
// The `kind` set is unchanged so existing URLs and the current UI keep working.
// Document Types remain owned by their dedicated route.
// ---------------------------------------------------------------------------

const SENSITIVE_FIELDS: Partial<Record<MasterKind, string[]>> = {
  "passport-visa": ["passport_number", "visa_number", "passport_path", "visa_path"],
  promotions: ["old_salary", "new_salary"],
}

function maskSensitive(kind: MasterKind, rows: any[]): any[] {
  const fields = SENSITIVE_FIELDS[kind]
  if (!fields) return rows
  return rows.map((r) => {
    const copy = { ...r }
    for (const f of fields) if (copy[f] !== null && copy[f] !== undefined && copy[f] !== "") copy[f] = "••••••"
    return copy
  })
}

function getConfig(kind: string) {
  return (MASTER_CONFIGS as Record<string, (typeof MASTER_CONFIGS)[MasterKind]>)[kind]
}

// --------------------------------------------------------------------------- GET
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureHrMasterSchema()

  const kind = (req.nextUrl.searchParams.get("kind") || "") as MasterKind
  const cfg = getConfig(kind)
  if (!cfg) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })

  let rows: any[]
  if (kind === "awards" || kind === "appreciations") {
    // Surface the employee's name + best email for certificate/email actions.
    rows = await query<any[]>(
      `SELECT t.*, e.employee_name AS employee_name, COALESCE(e.official_email,e.personal_email) AS employee_email
       FROM ${cfg.table} t LEFT JOIN hr_employees e ON e.id = t.employee_id
       ORDER BY t.${cfg.pk} DESC`,
    )
  } else if (kind === "promotions" || kind === "passport-visa") {
    rows = await query<any[]>(
      `SELECT t.*, e.employee_name AS employee_name, e.employee_id AS employee_code
       FROM ${cfg.table} t LEFT JOIN hr_employees e ON e.id = t.employee_id
       ORDER BY t.${cfg.pk} DESC`,
    )
  } else {
    rows = await query<any[]>(`SELECT * FROM ${cfg.table} ORDER BY ${cfg.pk} DESC`)
  }

  // Sensitive fields are masked unless the user is allowed to see them.
  if (!(await canViewSensitive(session))) rows = maskSensitive(kind, rows)
  return NextResponse.json({ rows })
}

// --------------------------------------------------------------------------- POST (create)
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureHrMasterSchema()

  const body = await req.json().catch(() => ({}))
  const kind = (body.kind || "") as MasterKind
  const cfg = getConfig(kind)
  if (!cfg) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  if (!(await canManageMaster(session))) {
    return NextResponse.json({ error: "You do not have permission to create master data." }, { status: 403 })
  }

  // Build the write payload from ONLY the allowlisted create fields. Anything
  // else the client sent (ids, codes, created_by, given_by, timestamps) is
  // ignored — those are server-controlled.
  const data = pickAllowed(cfg.createFields, body)
  stripAdminOnly(cfg, session, data)
  applyDerived(kind, data)

  const missing = cfg.required.filter((f) => data[f] === undefined || data[f] === null || data[f] === "")
  if (missing.length) return NextResponse.json({ error: `Missing required: ${missing.join(", ")}` }, { status: 400 })

  const refError = await validateRefs(cfg, data)
  if (refError) return NextResponse.json({ error: refError }, { status: 400 })

  // Hierarchy safety for the two tree masters.
  if (kind === "departments" && data.parent_department_id) {
    if (await wouldCreateCycle("hr_departments", "department_id", "parent_department_id", null, data.parent_department_id)) {
      return NextResponse.json({ error: "Parent department would create a circular hierarchy." }, { status: 400 })
    }
  }
  if (kind === "designations" && data.parent_designation_id) {
    if (await wouldCreateCycle("hr_designations", "designation_id", "parent_designation_id", null, data.parent_designation_id)) {
      return NextResponse.json({ error: "Parent designation would create a circular hierarchy." }, { status: 400 })
    }
  }

  // Business-duplicate guards.
  const dupError = await checkDuplicate(kind, data, null)
  if (dupError) return NextResponse.json({ error: dupError }, { status: 409 })

  // Set server-controlled giver identity (awards/appreciations).
  if (cfg.giverField) data[cfg.giverField] = session.name

  let newId: string | number
  if (cfg.idMode === "varchar") {
    const id = await nextVarcharId(cfg)
    data[cfg.pk] = id
    const fields = Object.keys(data)
    await query(
      `INSERT INTO ${cfg.table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      fields.map((f) => data[f]),
    )
    newId = id
  } else {
    // Numeric PK: insert, then derive the display code from the generated PK.
    newId = await insertAutoWithCode(cfg, data)
  }

  await writeMasterAudit({ module: kind, recordId: newId, action: "create", session, newValue: data })
  return NextResponse.json({ ok: true, id: newId }, { status: 201 })
}

// --------------------------------------------------------------------------- PATCH (update)
export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureHrMasterSchema()

  const body = await req.json().catch(() => ({}))
  const kind = (body.kind || "") as MasterKind
  const cfg = getConfig(kind)
  if (!cfg || body.id === undefined || body.id === null || body.id === "") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (!(await canManageMaster(session))) {
    return NextResponse.json({ error: "You do not have permission to edit master data." }, { status: 403 })
  }

  const existingRows = await query<any[]>(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ? LIMIT 1`, [body.id])
  if (!existingRows.length) return NextResponse.json({ error: "Record not found" }, { status: 404 })
  const existing = existingRows[0]

  const data = pickAllowed(cfg.updateFields, body)
  stripAdminOnly(cfg, session, data)
  applyDerived(kind, data)
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  const refError = await validateRefs(cfg, data)
  if (refError) return NextResponse.json({ error: refError }, { status: 400 })

  if (kind === "departments" && data.parent_department_id !== undefined) {
    if (await wouldCreateCycle("hr_departments", "department_id", "parent_department_id", String(body.id), data.parent_department_id || null)) {
      return NextResponse.json({ error: "Parent department would create a circular hierarchy." }, { status: 400 })
    }
  }
  if (kind === "designations" && data.parent_designation_id !== undefined) {
    if (await wouldCreateCycle("hr_designations", "designation_id", "parent_designation_id", String(body.id), data.parent_designation_id || null)) {
      return NextResponse.json({ error: "Parent designation would create a circular hierarchy." }, { status: 400 })
    }
  }

  const dupError = await checkDuplicate(kind, { ...existing, ...data }, String(body.id))
  if (dupError) return NextResponse.json({ error: dupError }, { status: 409 })

  // Promotion approval: stamp approver identity + timestamp server-side.
  if (kind === "promotions" && data.status === "Approved" && existing.status !== "Approved") {
    data.approved_by = session.userId
    data.approver_name = session.name
    data.approved_at = new Date()
  }

  const fields = Object.keys(data)
  await query(
    `UPDATE ${cfg.table} SET ${fields.map((f) => `${f}=?`).join(",")} WHERE ${cfg.pk}=?`,
    [...fields.map((f) => data[f]), body.id],
  )

  const action = data.status && data.status !== existing.status ? `status:${data.status}` : "update"
  await writeMasterAudit({
    module: kind,
    recordId: body.id,
    action,
    session,
    oldValue: pickAllowed(cfg.updateFields, existing),
    newValue: data,
  })
  return NextResponse.json({ ok: true })
}

// --------------------------------------------------------------------------- DELETE (dependency-aware)
export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureHrMasterSchema()

  const kind = (req.nextUrl.searchParams.get("kind") || "") as MasterKind
  const id = req.nextUrl.searchParams.get("id") || ""
  const cfg = getConfig(kind)
  if (!cfg || !id) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  if (!(await canManageMaster(session))) {
    return NextResponse.json({ error: "You do not have permission to deactivate master data." }, { status: 403 })
  }

  const existingRows = await query<any[]>(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ? LIMIT 1`, [id])
  if (!existingRows.length) return NextResponse.json({ error: "Record not found" }, { status: 404 })

  // Historical masters (departments/designations) are never hard-deleted when
  // anything depends on them — they are archived so history keeps resolving.
  const deps = await getDependencies(kind, id)
  if (deps.length) {
    await query(`UPDATE ${cfg.table} SET status = 'Inactive' WHERE ${cfg.pk} = ?`, [id])
    await writeMasterAudit({ module: kind, recordId: id, action: "deactivate", session, remarks: summarizeDeps(deps) })
    return NextResponse.json({ ok: true, deactivated: true, dependencies: deps })
  }

  await query(`DELETE FROM ${cfg.table} WHERE ${cfg.pk} = ?`, [id])
  await writeMasterAudit({ module: kind, recordId: id, action: "delete", session })
  return NextResponse.json({ ok: true, deleted: true })
}

// --------------------------------------------------------------------------- helpers

function pickAllowed(allowed: string[], source: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const f of allowed) if (source[f] !== undefined) out[f] = source[f] === "" ? null : source[f]
  return out
}

function stripAdminOnly(cfg: (typeof MASTER_CONFIGS)[MasterKind], session: SessionPayload, data: Record<string, any>) {
  if (session.role === "admin" || !cfg.adminOnlyFields) return
  for (const f of cfg.adminOnlyFields) delete data[f]
}

/** Fill server-derived fields (e.g. holiday year from the date). */
function applyDerived(kind: MasterKind, data: Record<string, any>) {
  if (kind === "holidays" && data.holiday_date) {
    const y = new Date(data.holiday_date).getFullYear()
    if (Number.isFinite(y)) data.year = y
  }
  if (kind === "holidays" && data.optional !== undefined) data.optional = data.optional ? 1 : 0
}

async function insertAutoWithCode(
  cfg: (typeof MASTER_CONFIGS)[MasterKind],
  data: Record<string, any>,
): Promise<number> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const fields = Object.keys(data)
    const [res]: any = await connection.query(
      `INSERT INTO ${cfg.table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      fields.map((f) => data[f]),
    )
    const insertId = Number(res.insertId)
    const year = data.year || (data.effective_date || data.award_date || data.appreciation_date
      ? new Date(data.effective_date || data.award_date || data.appreciation_date).getFullYear()
      : new Date().getFullYear())
    const code = formatAutoCode(cfg, insertId, year)
    await connection.query(`UPDATE ${cfg.table} SET ${cfg.codeColumn} = ? WHERE ${cfg.pk} = ?`, [code, insertId])
    await connection.commit()
    return insertId
  } catch (e) {
    await connection.rollback()
    throw e
  } finally {
    connection.release()
  }
}

/** Business-duplicate protection per master (spec §13, §63, §3). */
async function checkDuplicate(kind: MasterKind, data: Record<string, any>, excludeId: string | null): Promise<string | null> {
  if (kind === "departments" && data.department_name) {
    const rows = await query<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM hr_departments WHERE department_name = ? AND department_id <> ?",
      [data.department_name, excludeId ?? ""],
    )
    if (Number(rows[0]?.c || 0) > 0) return "A department with this name already exists."
  }
  if (kind === "designations" && data.designation_name) {
    const rows = await query<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM hr_designations WHERE designation_name = ? AND designation_id <> ?",
      [data.designation_name, excludeId ?? ""],
    )
    if (Number(rows[0]?.c || 0) > 0) return "A designation with this name already exists."
  }
  if (kind === "holidays" && data.holiday_date && data.holiday_name) {
    // Same holiday, same date, same department scope = duplicate. Different
    // regional holidays on the same date remain allowed.
    const rows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM hr_holidays
       WHERE holiday_date = ? AND holiday_name = ?
       AND COALESCE(applicable_department_id,'') = COALESCE(?, '')
       AND holiday_id <> ?`,
      [data.holiday_date, data.holiday_name, data.applicable_department_id ?? null, excludeId ?? "0"],
    )
    if (Number(rows[0]?.c || 0) > 0) return "A matching holiday already exists for this date and department."
  }
  return null
}

function summarizeDeps(deps: { label: string; count: number }[]): string {
  return "Deactivated (dependencies): " + deps.map((d) => `${d.count} ${d.label.toLowerCase()}`).join(", ")
}
