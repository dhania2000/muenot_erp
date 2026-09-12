import { pool, query } from "@/lib/db"
import { getUserMatrix } from "@/lib/permission-store"
import type { SessionPayload } from "@/lib/auth"

// ---------------------------------------------------------------------------
// HR Master Data — shared productionization layer.
//
// This module turns the previously-generic master-data CRUD into a set of
// domain-specific, server-authoritative handlers. It owns:
//   - per-master field policy (allowed / required / immutable / protected)
//   - server-side ID & display-code generation (never client supplied)
//   - cross-master reference validation (employees / departments / designations)
//   - circular-hierarchy prevention for Departments & Designations
//   - dependency checks that gate deactivate/delete (no destructive deletes)
//   - a single shared audit trail (hr_master_audit)
//   - idempotent runtime schema ensuring (mirrors ensureDocumentTypesSchema)
//
// It deliberately does NOT duplicate the Employees / Departments / Designations
// masters — every reference resolves back to the existing source-of-truth table.
// ---------------------------------------------------------------------------

export type MasterKind =
  | "departments"
  | "designations"
  | "promotions"
  | "awards"
  | "appreciations"
  | "passport-visa"
  | "holidays"

type RefKind = "employee" | "department" | "designation"

type MasterConfig = {
  table: string
  pk: string
  /** "varchar" = the PK itself is the human ID (DEPT-0001); "auto" = numeric PK + a display code column. */
  idMode: "varchar" | "auto"
  prefix: string
  /** For auto masters: the column that stores the generated display code. */
  codeColumn?: string
  /** true = code is `PREFIX-YEAR-000001`; false = `PREFIX-0001`. */
  yearScoped: boolean
  codeDigits: number
  /** Fields a client may set on create. */
  createFields: string[]
  /** Fields a client may change on update. */
  updateFields: string[]
  /** Required (non-empty) on create. */
  required: string[]
  /** Reference validations applied to whichever of these fields are present. */
  refs: { field: string; kind: RefKind; nullable?: boolean }[]
  /** Fields only an admin may set (e.g. salary). Stripped for non-admins. */
  adminOnlyFields?: string[]
  /** Server-controlled identity fields set from the session, not the client. */
  giverField?: string
}

export const MASTER_CONFIGS: Record<MasterKind, MasterConfig> = {
  departments: {
    table: "hr_departments",
    pk: "department_id",
    idMode: "varchar",
    prefix: "DEPT",
    yearScoped: false,
    codeDigits: 4,
    createFields: ["department_name", "parent_department_id", "head_employee_id", "description", "status"],
    updateFields: ["department_name", "parent_department_id", "head_employee_id", "description", "status"],
    required: ["department_name"],
    refs: [
      { field: "parent_department_id", kind: "department", nullable: true },
      { field: "head_employee_id", kind: "employee", nullable: true },
    ],
  },
  designations: {
    table: "hr_designations",
    pk: "designation_id",
    idMode: "varchar",
    prefix: "DESG",
    yearScoped: false,
    codeDigits: 4,
    createFields: ["designation_name", "parent_designation_id", "level_name", "description", "status"],
    updateFields: ["designation_name", "parent_designation_id", "level_name", "description", "status"],
    required: ["designation_name"],
    refs: [{ field: "parent_designation_id", kind: "designation", nullable: true }],
  },
  promotions: {
    table: "hr_promotions",
    pk: "promotion_id",
    idMode: "auto",
    prefix: "PROM",
    codeColumn: "promotion_code",
    yearScoped: true,
    codeDigits: 6,
    createFields: [
      "employee_id",
      "effective_date",
      "old_designation_id",
      "new_designation_id",
      "old_department_id",
      "new_department_id",
      "old_grade",
      "new_grade",
      "old_salary",
      "new_salary",
      "reason",
      "status",
    ],
    // employee_id is immutable after creation — a promotion belongs to one person.
    updateFields: [
      "effective_date",
      "new_designation_id",
      "new_department_id",
      "new_grade",
      "new_salary",
      "reason",
      "status",
    ],
    required: ["employee_id", "effective_date", "reason"],
    refs: [
      { field: "employee_id", kind: "employee" },
      { field: "old_designation_id", kind: "designation", nullable: true },
      { field: "new_designation_id", kind: "designation", nullable: true },
      { field: "old_department_id", kind: "department", nullable: true },
      { field: "new_department_id", kind: "department", nullable: true },
    ],
    adminOnlyFields: ["old_salary", "new_salary"],
  },
  awards: {
    table: "hr_awards",
    pk: "award_id",
    idMode: "auto",
    prefix: "AWD",
    codeColumn: "award_code",
    yearScoped: true,
    codeDigits: 6,
    createFields: ["employee_id", "award_name", "award_date", "description", "badge_url", "status"],
    updateFields: ["award_name", "award_date", "description", "badge_url", "status"],
    required: ["employee_id", "award_name", "award_date"],
    refs: [{ field: "employee_id", kind: "employee" }],
    giverField: "given_by",
  },
  appreciations: {
    table: "hr_appreciations",
    pk: "appreciation_id",
    idMode: "auto",
    prefix: "APP",
    codeColumn: "appreciation_code",
    yearScoped: true,
    codeDigits: 6,
    createFields: ["employee_id", "title", "message", "appreciation_date", "category", "status"],
    updateFields: ["title", "message", "appreciation_date", "category", "status"],
    required: ["employee_id", "title", "message"],
    refs: [{ field: "employee_id", kind: "employee" }],
    giverField: "given_by",
  },
  "passport-visa": {
    table: "hr_passport_visa",
    pk: "record_id",
    idMode: "auto",
    prefix: "PVR",
    codeColumn: "pv_code",
    yearScoped: false,
    codeDigits: 4,
    createFields: [
      "employee_id",
      "passport_number",
      "passport_issue_date",
      "passport_expiry_date",
      "visa_type",
      "visa_number",
      "visa_issue_date",
      "visa_expiry_date",
      "country",
      "passport_path",
      "visa_path",
      "remarks",
      "status",
    ],
    updateFields: [
      "passport_number",
      "passport_issue_date",
      "passport_expiry_date",
      "visa_type",
      "visa_number",
      "visa_issue_date",
      "visa_expiry_date",
      "country",
      "passport_path",
      "visa_path",
      "remarks",
      "status",
    ],
    required: ["employee_id"],
    refs: [{ field: "employee_id", kind: "employee" }],
  },
  holidays: {
    table: "hr_holidays",
    pk: "holiday_id",
    idMode: "auto",
    prefix: "HOL",
    codeColumn: "holiday_code",
    yearScoped: true,
    codeDigits: 6,
    createFields: [
      "holiday_name",
      "holiday_date",
      "holiday_type",
      "applicable_department_id",
      "applicable_state_ut",
      "optional",
      "description",
      "status",
    ],
    updateFields: [
      "holiday_name",
      "holiday_date",
      "holiday_type",
      "applicable_department_id",
      "applicable_state_ut",
      "optional",
      "description",
      "status",
    ],
    required: ["holiday_name", "holiday_date"],
    refs: [{ field: "applicable_department_id", kind: "department", nullable: true }],
  },
}

// ---------------------------------------------------------------------------
// Schema ensuring (idempotent, runtime — safe against the live production DB)
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  return Number(rows[0]?.c || 0) > 0
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index],
  )
  return Number(rows[0]?.c || 0) > 0
}

async function ensureIndex(table: string, index: string, columns: string) {
  if (!(await indexExists(table, index))) {
    await query(`ALTER TABLE ${table} ADD INDEX ${index} (${columns})`)
  }
}

export function ensureHrMasterSchema(): Promise<void> {
  if (!schemaReady) schemaReady = doEnsure()
  return schemaReady
}

async function doEnsure() {
  // Shared audit trail for every master change (single table, not per-module).
  await query(`
    CREATE TABLE IF NOT EXISTS hr_master_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      module VARCHAR(40) NOT NULL,
      record_id VARCHAR(80) NOT NULL,
      action VARCHAR(40) NOT NULL,
      user_id INT NULL,
      user_name VARCHAR(150) NULL,
      old_value JSON NULL,
      new_value JSON NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'master-data',
      remarks VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_hma_module (module),
      KEY idx_hma_record (module, record_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Display-code columns for the numeric-PK masters, with a backfill derived
  // deterministically from the existing PK so historical rows get stable codes.
  const backfills: { table: string; pk: string; col: string; expr: (pk: string) => string }[] = [
    { table: "hr_promotions", pk: "promotion_id", col: "promotion_code", expr: (p) => `CONCAT('PROM-', YEAR(created_at), '-', LPAD(${p},6,'0'))` },
    { table: "hr_awards", pk: "award_id", col: "award_code", expr: (p) => `CONCAT('AWD-', YEAR(created_at), '-', LPAD(${p},6,'0'))` },
    { table: "hr_appreciations", pk: "appreciation_id", col: "appreciation_code", expr: (p) => `CONCAT('APP-', YEAR(created_at), '-', LPAD(${p},6,'0'))` },
    { table: "hr_holidays", pk: "holiday_id", col: "holiday_code", expr: (p) => `CONCAT('HOL-', COALESCE(year, YEAR(created_at)), '-', LPAD(${p},6,'0'))` },
    { table: "hr_passport_visa", pk: "record_id", col: "pv_code", expr: (p) => `CONCAT('PVR-', LPAD(${p},4,'0'))` },
  ]
  for (const b of backfills) {
    if (!(await columnExists(b.table, b.col))) {
      await query(`ALTER TABLE ${b.table} ADD COLUMN ${b.col} VARCHAR(40) NULL`)
    }
    await query(`UPDATE ${b.table} SET ${b.col} = ${b.expr(b.pk)} WHERE ${b.col} IS NULL OR ${b.col} = ''`)
    await ensureIndex(b.table, `uniq_${b.col}`, b.col)
  }

  // Promotions need an approval/effective-date audit trail column set.
  for (const col of ["approved_at", "effected_at"]) {
    if (!(await columnExists("hr_promotions", col))) {
      await query(`ALTER TABLE hr_promotions ADD COLUMN ${col} TIMESTAMP NULL`)
    }
  }

  // Query-pattern indexes (spec §62). Added only when missing.
  await ensureIndex("hr_departments", "idx_dept_status", "status")
  await ensureIndex("hr_departments", "idx_dept_parent", "parent_department_id")
  await ensureIndex("hr_designations", "idx_desg_status", "status")
  await ensureIndex("hr_designations", "idx_desg_parent", "parent_designation_id")
  await ensureIndex("hr_promotions", "idx_prom_emp", "employee_id")
  await ensureIndex("hr_promotions", "idx_prom_eff", "effective_date")
  await ensureIndex("hr_promotions", "idx_prom_status", "status")
  await ensureIndex("hr_awards", "idx_awd_emp", "employee_id")
  await ensureIndex("hr_appreciations", "idx_app_emp", "employee_id")
  await ensureIndex("hr_passport_visa", "idx_pv_emp", "employee_id")
  await ensureIndex("hr_passport_visa", "idx_pv_pexp", "passport_expiry_date")
  await ensureIndex("hr_passport_visa", "idx_pv_vexp", "visa_expiry_date")
  await ensureIndex("hr_holidays", "idx_hol_date", "holiday_date")
  await ensureIndex("hr_holidays", "idx_hol_dept", "applicable_department_id")
  await ensureIndex("hr_holidays", "idx_hol_status", "status")
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Can the user manage (create/update/deactivate) HR master data? */
export async function canManageMaster(session: SessionPayload): Promise<boolean> {
  if (session.role === "admin") return true
  const matrix = await getUserMatrix(session.userId)
  const p = matrix?.["hr.master"]
  return !!p && (p.add === "all" || p.update === "all")
}

/** Can the user see sensitive fields (passport/visa numbers, document paths, salary)? */
export async function canViewSensitive(session: SessionPayload): Promise<boolean> {
  if (session.role === "admin") return true
  const matrix = await getUserMatrix(session.userId)
  const p = matrix?.["hr.master"]
  return !!p && p.view === "all"
}

// ---------------------------------------------------------------------------
// ID / display-code generation (server-side, race-safe)
// ---------------------------------------------------------------------------

async function nextSeq(key: string): Promise<number> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1",
      [key],
    )
    const [rows] = await connection.query<any[]>(
      "SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE",
      [key],
    )
    await connection.commit()
    return Number(rows[0]?.next_number || 1)
  } catch (e) {
    await connection.rollback()
    throw e
  } finally {
    connection.release()
  }
}

/** Generate the next VARCHAR primary key for Departments / Designations (DEPT-0001). */
async function nextVarcharId(cfg: MasterConfig): Promise<string> {
  // Seed the sequence from any existing max suffix so we never collide with
  // legacy manually-entered IDs on first use.
  const rows = await query<{ m: number }[]>(
    `SELECT COALESCE(MAX(CAST(REGEXP_SUBSTR(${cfg.pk}, '[0-9]+$') AS UNSIGNED)), 0) AS m
     FROM ${cfg.table} WHERE ${cfg.pk} LIKE ?`,
    [`${cfg.prefix}-%`],
  )
  const existingMax = Number(rows[0]?.m || 0)
  const seedRow = await query<{ n: number }[]>(
    "SELECT next_number AS n FROM record_id_sequences WHERE prefix = ?",
    [cfg.prefix],
  )
  const seqCurrent = Number(seedRow[0]?.n || 0)
  if (existingMax > seqCurrent) {
    await query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, ?) ON DUPLICATE KEY UPDATE next_number = ?",
      [cfg.prefix, existingMax, existingMax],
    )
  }
  const n = await nextSeq(cfg.prefix)
  return `${cfg.prefix}-${String(n).padStart(cfg.codeDigits, "0")}`
}

/** Format the display code for an auto-PK master from its generated PK. */
export function formatAutoCode(cfg: MasterConfig, pkValue: number, year: number): string {
  if (cfg.yearScoped) return `${cfg.prefix}-${year}-${String(pkValue).padStart(cfg.codeDigits, "0")}`
  return `${cfg.prefix}-${String(pkValue).padStart(cfg.codeDigits, "0")}`
}

export { nextVarcharId }

// ---------------------------------------------------------------------------
// Reference validation
// ---------------------------------------------------------------------------

async function refExists(kind: RefKind, value: any): Promise<boolean> {
  const v = String(value)
  if (kind === "employee") {
    const r = await query<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM hr_employees WHERE id = ? OR employee_id = ?",
      [Number(value) || 0, v],
    )
    return Number(r[0]?.c || 0) > 0
  }
  if (kind === "department") {
    const r = await query<{ c: number }[]>("SELECT COUNT(*) AS c FROM hr_departments WHERE department_id = ?", [v])
    return Number(r[0]?.c || 0) > 0
  }
  const r = await query<{ c: number }[]>("SELECT COUNT(*) AS c FROM hr_designations WHERE designation_id = ?", [v])
  return Number(r[0]?.c || 0) > 0
}

function isBlank(v: any): boolean {
  return v === undefined || v === null || v === ""
}

/** Validate all reference fields present in `data`. Returns an error message or null. */
export async function validateRefs(cfg: MasterConfig, data: Record<string, any>): Promise<string | null> {
  for (const ref of cfg.refs) {
    if (!(ref.field in data)) continue
    const value = data[ref.field]
    if (isBlank(value)) {
      if (ref.nullable) continue
      return `${ref.field} is required.`
    }
    if (!(await refExists(ref.kind, value))) {
      return `Referenced ${ref.kind} "${value}" does not exist.`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Circular-hierarchy prevention (Departments & Designations)
// ---------------------------------------------------------------------------

/**
 * Returns true if setting `parentId` as the parent of `nodeId` would create a
 * cycle. Walks up the parent chain from `parentId` looking for `nodeId`.
 */
export async function wouldCreateCycle(
  table: string,
  pk: string,
  parentCol: string,
  nodeId: string | null,
  parentId: string | null,
): Promise<boolean> {
  if (!parentId) return false
  if (nodeId && parentId === nodeId) return true
  let current: string | null = parentId
  const seen = new Set<string>()
  while (current) {
    if (nodeId && current === nodeId) return true
    if (seen.has(current)) return true // pre-existing cycle guard
    seen.add(current)
    const rows: any[] = await query<any[]>(`SELECT ${parentCol} AS parent FROM ${table} WHERE ${pk} = ? LIMIT 1`, [current])
    current = rows.length ? (rows[0].parent ?? null) : null
  }
  return false
}

// ---------------------------------------------------------------------------
// Dependency checks (gate deactivate / delete — never break history)
// ---------------------------------------------------------------------------

export type Dependency = { label: string; count: number }

/** Count records that depend on a given master row. */
export async function getDependencies(kind: MasterKind, id: string): Promise<Dependency[]> {
  const deps: Dependency[] = []
  const count = async (label: string, sql: string, params: any[]) => {
    const r = await query<{ c: number }[]>(sql, params)
    const c = Number(r[0]?.c || 0)
    if (c > 0) deps.push({ label, count: c })
  }

  if (kind === "departments") {
    const nameRows = await query<{ n: string }[]>(
      "SELECT department_name AS n FROM hr_departments WHERE department_id = ? LIMIT 1",
      [id],
    )
    const name = nameRows[0]?.n
    if (name) await count("Employees", "SELECT COUNT(*) AS c FROM hr_employees WHERE department = ?", [name])
    await count(
      "Promotions",
      "SELECT COUNT(*) AS c FROM hr_promotions WHERE old_department_id = ? OR new_department_id = ?",
      [id, id],
    )
    await count("Holidays", "SELECT COUNT(*) AS c FROM hr_holidays WHERE applicable_department_id = ?", [id])
    await count("Child departments", "SELECT COUNT(*) AS c FROM hr_departments WHERE parent_department_id = ?", [id])
  } else if (kind === "designations") {
    const nameRows = await query<{ n: string }[]>(
      "SELECT designation_name AS n FROM hr_designations WHERE designation_id = ? LIMIT 1",
      [id],
    )
    const name = nameRows[0]?.n
    if (name) await count("Employees", "SELECT COUNT(*) AS c FROM hr_employees WHERE designation = ?", [name])
    await count(
      "Promotions",
      "SELECT COUNT(*) AS c FROM hr_promotions WHERE old_designation_id = ? OR new_designation_id = ?",
      [id, id],
    )
    await count(
      "Child designations",
      "SELECT COUNT(*) AS c FROM hr_designations WHERE parent_designation_id = ?",
      [id],
    )
  }
  return deps
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function writeMasterAudit(entry: {
  module: MasterKind
  recordId: string | number
  action: string
  session: SessionPayload
  oldValue?: any
  newValue?: any
  remarks?: string
}) {
  await query(
    `INSERT INTO hr_master_audit (module, record_id, action, user_id, user_name, old_value, new_value, remarks)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      entry.module,
      String(entry.recordId),
      entry.action,
      entry.session.userId,
      entry.session.name,
      entry.oldValue ? JSON.stringify(entry.oldValue) : null,
      entry.newValue ? JSON.stringify(entry.newValue) : null,
      entry.remarks ?? null,
    ],
  )
}

// ---------------------------------------------------------------------------
// Expiry status (Passport / Visa) — derived, never stored, so it can never
// drift from the real dates. Reuses one threshold everywhere (spec §11, §44).
// ---------------------------------------------------------------------------

export const EXPIRY_SOON_DAYS = 60

export type ExpiryStatus = "Valid" | "Expiring Soon" | "Expired" | null

/** Classify a single expiry date relative to today. Null when there is no date. */
export function computeExpiryStatus(date: any, soonDays = EXPIRY_SOON_DAYS): ExpiryStatus {
  if (isBlank(date)) return null
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  d.setHours(0, 0, 0, 0)
  const days = Math.floor((d.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return "Expired"
  if (days <= soonDays) return "Expiring Soon"
  return "Valid"
}

/** Merge passport + visa statuses into the "worst" single status for a row. */
function worstStatus(a: ExpiryStatus, b: ExpiryStatus): ExpiryStatus {
  const rank: Record<string, number> = { Expired: 3, "Expiring Soon": 2, Valid: 1 }
  const cand = [a, b].filter(Boolean) as Exclude<ExpiryStatus, null>[]
  if (!cand.length) return null
  return cand.sort((x, y) => rank[y] - rank[x])[0]
}

/** Annotate passport/visa rows with derived expiry status fields for the UI. */
export function annotatePassportVisa(rows: any[]): any[] {
  return rows.map((r) => {
    const passport_status = computeExpiryStatus(r.passport_expiry_date)
    const visa_status = computeExpiryStatus(r.visa_expiry_date)
    return { ...r, passport_status, visa_status, expiry_status: worstStatus(passport_status, visa_status) }
  })
}

// ---------------------------------------------------------------------------
// Promotion conflict detection (spec §8) — an employee may not have two open
// or same-day organizational changes at once.
// ---------------------------------------------------------------------------

export async function checkPromotionConflict(
  employeeId: any,
  effectiveDate: any,
  excludeId: string | number | null,
): Promise<string | null> {
  if (isBlank(employeeId)) return null
  const rows = await query<{ promotion_id: number; effective_date: any; status: string; effected_at: any }[]>(
    `SELECT promotion_id, effective_date, status, effected_at
       FROM hr_promotions
      WHERE employee_id = ? AND promotion_id <> ? AND status IN ('Pending','Approved') AND effected_at IS NULL`,
    [Number(employeeId) || 0, Number(excludeId) || 0],
  )
  if (!rows.length) return null
  const eff = effectiveDate ? String(effectiveDate).slice(0, 10) : null
  for (const r of rows) {
    const rEff = r.effective_date ? String(new Date(r.effective_date).toISOString()).slice(0, 10) : null
    if (eff && rEff && eff === rEff) {
      return `This employee already has a ${r.status.toLowerCase()} promotion effective on the same date.`
    }
  }
  const pending = rows.find((r) => r.status === "Pending")
  if (pending) return "This employee already has a pending promotion awaiting approval."
  const approved = rows.find((r) => r.status === "Approved")
  if (approved) return "This employee already has an approved promotion that has not taken effect yet."
  return null
}

// ---------------------------------------------------------------------------
// Effective-date employee update job (spec §7, §39, §76).
//
// Applies every Approved promotion whose effective date has arrived and which
// has not yet been effected, updating the employee master (department /
// designation / grade resolved from the master IDs) transaction-safely. The
// promotion history keeps its own old/new snapshot untouched.
// ---------------------------------------------------------------------------

export type PromotionApplyResult = {
  applied: { promotion_id: number; employee_id: number; changes: string[] }[]
  skipped: { promotion_id: number; reason: string }[]
}

export async function applyDuePromotions(session: SessionPayload): Promise<PromotionApplyResult> {
  const due = await query<any[]>(
    `SELECT * FROM hr_promotions
      WHERE status = 'Approved' AND effected_at IS NULL AND effective_date <= CURDATE()
      ORDER BY effective_date ASC, promotion_id ASC`,
  )
  const result: PromotionApplyResult = { applied: [], skipped: [] }

  for (const p of due) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [empRows]: any = await connection.query("SELECT * FROM hr_employees WHERE id = ? LIMIT 1 FOR UPDATE", [
        p.employee_id,
      ])
      if (!empRows.length) {
        await connection.rollback()
        result.skipped.push({ promotion_id: p.promotion_id, reason: "Employee not found" })
        continue
      }
      const emp = empRows[0]
      const set: Record<string, any> = {}
      const changes: string[] = []

      if (p.new_department_id) {
        const [d]: any = await connection.query(
          "SELECT department_name FROM hr_departments WHERE department_id = ? LIMIT 1",
          [p.new_department_id],
        )
        const name = d[0]?.department_name
        if (name && name !== emp.department) {
          set.department = name
          changes.push(`department → ${name}`)
        }
      }
      if (p.new_designation_id) {
        const [d]: any = await connection.query(
          "SELECT designation_name FROM hr_designations WHERE designation_id = ? LIMIT 1",
          [p.new_designation_id],
        )
        const name = d[0]?.designation_name
        if (name && name !== emp.designation) {
          set.designation = name
          changes.push(`designation → ${name}`)
        }
      }
      if (p.new_grade && p.new_grade !== emp.employee_grade) {
        set.employee_grade = p.new_grade
        changes.push(`grade → ${p.new_grade}`)
      }

      const fields = Object.keys(set)
      if (fields.length) {
        await connection.query(
          `UPDATE hr_employees SET ${fields.map((f) => `${f}=?`).join(",")} WHERE id = ?`,
          [...fields.map((f) => set[f]), p.employee_id],
        )
      }
      await connection.query("UPDATE hr_promotions SET effected_at = NOW() WHERE promotion_id = ?", [p.promotion_id])
      await connection.commit()

      result.applied.push({ promotion_id: p.promotion_id, employee_id: p.employee_id, changes })
      // Audit is written outside the txn so a logging failure never rolls back
      // an already-applied employee change.
      await writeMasterAudit({
        module: "promotions",
        recordId: p.promotion_id,
        action: "effected",
        session,
        newValue: { employee_id: p.employee_id, changes },
        remarks: changes.length ? changes.join(", ") : "No employee field changes required.",
      })
    } catch (e) {
      await connection.rollback()
      result.skipped.push({ promotion_id: p.promotion_id, reason: (e as Error).message })
    } finally {
      connection.release()
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// HR Master Data summary + data-quality (spec §33, §34, §69). All real data;
// every group is isolated so one failing query cannot blank the whole panel.
// ---------------------------------------------------------------------------

async function safeCount(sql: string, params: any[] = []): Promise<number> {
  try {
    const r = await query<{ c: number }[]>(sql, params)
    return Number(r[0]?.c || 0)
  } catch {
    return 0
  }
}

export type DataQualityIssue = { key: string; label: string; count: number; kind?: MasterKind }

export async function getMasterSummary() {
  const [
    deptTotal,
    deptActive,
    desgTotal,
    desgActive,
    docTotal,
    docRequired,
    promPending,
    promApproved,
    promUpcoming,
    promDue,
    awardsThisYear,
    apprThisMonth,
    holUpcoming,
    holThisYear,
  ] = await Promise.all([
    safeCount("SELECT COUNT(*) c FROM hr_departments"),
    safeCount("SELECT COUNT(*) c FROM hr_departments WHERE status = 'Active'"),
    safeCount("SELECT COUNT(*) c FROM hr_designations"),
    safeCount("SELECT COUNT(*) c FROM hr_designations WHERE status = 'Active'"),
    safeCount("SELECT COUNT(*) c FROM hr_document_types"),
    safeCount("SELECT COUNT(*) c FROM hr_document_types WHERE is_required = 1"),
    safeCount("SELECT COUNT(*) c FROM hr_promotions WHERE status = 'Pending'"),
    safeCount("SELECT COUNT(*) c FROM hr_promotions WHERE status = 'Approved'"),
    safeCount("SELECT COUNT(*) c FROM hr_promotions WHERE status = 'Approved' AND effected_at IS NULL AND effective_date > CURDATE()"),
    safeCount("SELECT COUNT(*) c FROM hr_promotions WHERE status = 'Approved' AND effected_at IS NULL AND effective_date <= CURDATE()"),
    safeCount("SELECT COUNT(*) c FROM hr_awards WHERE YEAR(award_date) = YEAR(CURDATE())"),
    safeCount("SELECT COUNT(*) c FROM hr_appreciations WHERE MONTH(appreciation_date) = MONTH(CURDATE()) AND YEAR(appreciation_date) = YEAR(CURDATE())"),
    safeCount("SELECT COUNT(*) c FROM hr_holidays WHERE holiday_date >= CURDATE() AND status = 'Active'"),
    safeCount("SELECT COUNT(*) c FROM hr_holidays WHERE YEAR(holiday_date) = YEAR(CURDATE())"),
  ])

  const soon = `DATE_ADD(CURDATE(), INTERVAL ${EXPIRY_SOON_DAYS} DAY)`
  const [pExpired, pSoon, vExpired, vSoon] = await Promise.all([
    safeCount("SELECT COUNT(*) c FROM hr_passport_visa WHERE passport_expiry_date < CURDATE()"),
    safeCount(`SELECT COUNT(*) c FROM hr_passport_visa WHERE passport_expiry_date >= CURDATE() AND passport_expiry_date <= ${soon}`),
    safeCount("SELECT COUNT(*) c FROM hr_passport_visa WHERE visa_expiry_date < CURDATE()"),
    safeCount(`SELECT COUNT(*) c FROM hr_passport_visa WHERE visa_expiry_date >= CURDATE() AND visa_expiry_date <= ${soon}`),
  ])

  // Data-quality issues (actionable, never auto-corrected — spec §34).
  const issues: DataQualityIssue[] = []
  const add = async (key: string, label: string, sql: string, kind?: MasterKind) => {
    const c = await safeCount(sql)
    if (c > 0) issues.push({ key, label, count: c, kind })
  }
  await add(
    "emp_no_dept",
    "Active employees without a department",
    "SELECT COUNT(*) c FROM hr_employees WHERE employment_status = 'Active' AND (department IS NULL OR department = '')",
  )
  await add(
    "emp_no_desg",
    "Active employees without a designation",
    "SELECT COUNT(*) c FROM hr_employees WHERE employment_status = 'Active' AND (designation IS NULL OR designation = '')",
  )
  await add(
    "emp_inactive_dept",
    "Employees assigned to an inactive department",
    "SELECT COUNT(*) c FROM hr_employees e JOIN hr_departments d ON d.department_name = e.department WHERE d.status <> 'Active'",
    "departments",
  )
  await add(
    "emp_inactive_desg",
    "Employees assigned to an inactive designation",
    "SELECT COUNT(*) c FROM hr_employees e JOIN hr_designations d ON d.designation_name = e.designation WHERE d.status <> 'Active'",
    "designations",
  )
  await add(
    "passport_expired",
    "Records with an expired passport",
    "SELECT COUNT(*) c FROM hr_passport_visa WHERE passport_expiry_date < CURDATE()",
    "passport-visa",
  )
  await add(
    "visa_expired",
    "Records with an expired visa",
    "SELECT COUNT(*) c FROM hr_passport_visa WHERE visa_expiry_date < CURDATE()",
    "passport-visa",
  )
  await add(
    "prom_due",
    "Approved promotions ready to take effect",
    "SELECT COUNT(*) c FROM hr_promotions WHERE status = 'Approved' AND effected_at IS NULL AND effective_date <= CURDATE()",
    "promotions",
  )
  await add(
    "holiday_dupes",
    "Duplicate holidays (same date, name & scope)",
    `SELECT COUNT(*) c FROM (
       SELECT holiday_date, holiday_name, COALESCE(applicable_department_id,'') d
       FROM hr_holidays GROUP BY holiday_date, holiday_name, d HAVING COUNT(*) > 1
     ) x`,
    "holidays",
  )

  return {
    departments: { total: deptTotal, active: deptActive, inactive: deptTotal - deptActive },
    designations: { total: desgTotal, active: desgActive, inactive: desgTotal - desgActive },
    documentTypes: { total: docTotal, required: docRequired },
    promotions: { pending: promPending, approved: promApproved, upcoming: promUpcoming, due: promDue },
    awards: { thisYear: awardsThisYear },
    appreciations: { thisMonth: apprThisMonth },
    passportVisa: {
      passportExpired: pExpired,
      passportExpiring: pSoon,
      visaExpired: vExpired,
      visaExpiring: vSoon,
    },
    holidays: { upcoming: holUpcoming, thisYear: holThisYear },
    dataQuality: issues,
  }
}
