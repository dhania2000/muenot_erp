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
