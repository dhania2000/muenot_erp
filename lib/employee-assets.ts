import "server-only"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { notify } from "@/lib/sales/lead-lifecycle"
import type { SessionPayload } from "@/lib/auth"
import { scopeWhereForModule } from "@/lib/permission-enforce"

/**
 * Employee Assets — assignment layer over Finance → Fixed Assets.
 * ---------------------------------------------------------------------------
 * This module NEVER owns asset master data. Finance `fixed_assets` remains the
 * single source of truth for the asset name / code / category / status / value.
 * Here we only maintain the *assignment* of a company-owned fixed asset to an
 * HR employee and its lifecycle (assign → return → reassign, plus lost /
 * damaged / under-repair), a full audit trail, and derived availability.
 *
 * Relationships (all by existing records, no duplicates):
 *   fixed_assets.asset_id  ←  employee_asset_assignments.finance_fixed_asset_id
 *   hr_employees.id        ←  employee_asset_assignments.employee_id
 *
 * Concurrency / duplicate protection: an asset may have at most ONE active
 * assignment at a time. Enforced both by a row-locking transaction and by a
 * UNIQUE index on `active_asset_key` (set to the asset id only while the
 * assignment occupies the asset, NULL otherwise — MySQL allows many NULLs).
 */

// ── Domain constants ─────────────────────────────────────────────────────────

export const ASSIGNMENT_STATUSES = [
  "Assigned",
  "Returned",
  "Under Repair",
  "Lost",
  "Damaged",
  "Disposed",
] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

export const CONDITIONS = ["New", "Good", "Fair", "Damaged"] as const

/** Assignment statuses that keep the underlying asset occupied / unavailable. */
export const OCCUPYING_STATUSES: AssignmentStatus[] = ["Assigned", "Under Repair"]

/** Finance statuses in which an asset can NEVER be assigned. */
export const NON_ASSIGNABLE_FINANCE_STATUSES = new Set([
  "Disposed",
  "Scrapped",
  "Archived",
  "Under Repair",
])

/** Finance statuses that are terminal (asset gone) — sync assignments to Disposed. */
export const CLOSED_FINANCE_STATUSES = new Set(["Disposed", "Scrapped", "Archived"])

/** HR employment statuses treated as inactive (blocked from new assignments). */
export const INACTIVE_EMPLOYMENT_STATUSES = new Set([
  "Inactive",
  "Terminated",
  "Resigned",
  "Exited",
  "Relieved",
  "Separated",
  "Left",
  "Offboarded",
])

export const PERMISSION_KEY = "assets.employee_assets"
const MODULE_LINK = "/modules/assets/employee-assets"

// ── Schema (self-healing) ────────────────────────────────────────────────────

let schemaEnsured = false

export async function ensureEmployeeAssetSchema(): Promise<void> {
  if (schemaEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS employee_asset_assignments (
    id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
    assignment_id           VARCHAR(30) NOT NULL,
    finance_fixed_asset_id  VARCHAR(30) NOT NULL,
    employee_id             INT UNSIGNED NOT NULL,
    employee_ref            VARCHAR(40) DEFAULT NULL,
    employee_name           VARCHAR(190) DEFAULT NULL,
    department              VARCHAR(120) DEFAULT NULL,
    assignment_date         DATE NOT NULL,
    expected_return_date    DATE DEFAULT NULL,
    condition_at_assignment VARCHAR(20) DEFAULT NULL,
    purpose                 VARCHAR(255) DEFAULT NULL,
    remarks                 TEXT DEFAULT NULL,
    assigned_by             INT UNSIGNED DEFAULT NULL,
    assigned_by_name        VARCHAR(190) DEFAULT NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'Assigned',
    return_date             DATE DEFAULT NULL,
    condition_at_return     VARCHAR(20) DEFAULT NULL,
    return_remarks          TEXT DEFAULT NULL,
    received_by             INT UNSIGNED DEFAULT NULL,
    received_by_name        VARCHAR(190) DEFAULT NULL,
    event_date              DATE DEFAULT NULL,
    event_reason            VARCHAR(255) DEFAULT NULL,
    event_remarks           TEXT DEFAULT NULL,
    reported_by             INT UNSIGNED DEFAULT NULL,
    reported_by_name        VARCHAR(190) DEFAULT NULL,
    active_asset_key        VARCHAR(30) DEFAULT NULL,
    reminder_sent_for       VARCHAR(20) DEFAULT NULL,
    created_by              INT UNSIGNED DEFAULT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_assignment_id (assignment_id),
    UNIQUE KEY uq_active_asset (active_asset_key),
    KEY idx_eaa_asset (finance_fixed_asset_id),
    KEY idx_eaa_employee (employee_id),
    KEY idx_eaa_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS employee_asset_audit (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    assignment_id  VARCHAR(30) DEFAULT NULL,
    asset_id       VARCHAR(30) DEFAULT NULL,
    action         VARCHAR(40) NOT NULL,
    user_id        INT UNSIGNED DEFAULT NULL,
    user_name      VARCHAR(190) DEFAULT NULL,
    old_value      TEXT DEFAULT NULL,
    new_value      TEXT DEFAULT NULL,
    reason         VARCHAR(255) DEFAULT NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_eaudit_assignment (assignment_id),
    KEY idx_eaudit_asset (asset_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => (v ? String(v).slice(0, 10) : null)
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function isValidDate(v: any): boolean {
  if (!v) return false
  const t = Date.parse(String(v))
  return Number.isFinite(t)
}

export class AssetAssignmentError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

async function recordAudit(input: {
  assignmentId?: string | null
  assetId?: string | null
  action: string
  userId?: number | null
  userName?: string | null
  oldValue?: any
  newValue?: any
  reason?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO employee_asset_audit
       (assignment_id, asset_id, action, user_id, user_name, old_value, new_value, reason)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.assignmentId ?? null,
      input.assetId ?? null,
      input.action,
      input.userId ?? null,
      input.userName ?? null,
      input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      input.newValue != null ? JSON.stringify(input.newValue) : null,
      input.reason ?? null,
    ],
  ).catch((e) => console.log("[v0] asset audit insert failed", (e as Error).message))
}

/** Best-effort in-app notification to the employee's linked login account. */
async function notifyEmployee(
  employeeId: number,
  input: { title: string; body: string; type?: string; entityId?: string | null },
): Promise<void> {
  const [emp] = (await query(`SELECT user_id FROM hr_employees WHERE id = ? LIMIT 1`, [employeeId]).catch(
    () => [],
  )) as any[]
  const userId = emp?.user_id ? Number(emp.user_id) : null
  if (!userId) return
  await notify(null, {
    userId,
    type: input.type ?? "employee-asset",
    title: input.title,
    body: input.body,
    link: MODULE_LINK,
    entityType: "employee_asset_assignment",
    entityId: input.entityId ?? null,
  }).catch(() => {})
}

// ── Lookups (Finance Fixed Assets + HR Employees) ─────────────────────────────

export type AssetLookupRow = {
  asset_id: string
  asset_name: string | null
  asset_category: string | null
  asset_type: string | null
  status: string | null
  cost: number
  capitalised_cost: number
  net_book_value: number
  location: string | null
  custodian: string | null
}

/**
 * Available (assignable) fixed assets: not in a terminal / under-repair finance
 * status and with no active employee assignment. Optional free-text search over
 * asset id / name / category / type.
 */
export async function listAvailableAssets(search?: string | null): Promise<AssetLookupRow[]> {
  await ensureEmployeeAssetSchema()
  const args: any[] = []
  let searchSql = ""
  if (search && search.trim()) {
    const like = `%${search.trim()}%`
    searchSql = ` AND (fa.asset_id LIKE ? OR fa.asset_name LIKE ? OR fa.asset_category LIKE ? OR fa.asset_type LIKE ?)`
    args.push(like, like, like, like)
  }
  const nonAssignable = Array.from(NON_ASSIGNABLE_FINANCE_STATUSES)
  const rows = (await query(
    `SELECT fa.asset_id, fa.asset_name, fa.asset_category, fa.asset_type, fa.status,
            fa.cost, fa.capitalised_cost, fa.net_book_value, fa.location, fa.custodian
       FROM fixed_assets fa
      WHERE (fa.status IS NULL OR fa.status NOT IN (${nonAssignable.map(() => "?").join(",")}))
        AND NOT EXISTS (
          SELECT 1 FROM employee_asset_assignments a
           WHERE a.finance_fixed_asset_id = fa.asset_id
             AND a.status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")})
        )
        ${searchSql}
      ORDER BY fa.asset_id DESC
      LIMIT 500`,
    [...nonAssignable, ...OCCUPYING_STATUSES, ...args],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    asset_id: String(r.asset_id),
    asset_name: r.asset_name ?? null,
    asset_category: r.asset_category ?? null,
    asset_type: r.asset_type ?? null,
    status: r.status ?? null,
    cost: num(r.cost),
    capitalised_cost: num(r.capitalised_cost),
    net_book_value: num(r.net_book_value),
    location: r.location ?? null,
    custodian: r.custodian ?? null,
  }))
}

export type EmployeeLookupRow = {
  id: number
  employee_id: string | null
  employee_name: string | null
  department: string | null
  designation: string | null
  employment_status: string | null
  active: boolean
}

/** HR Employee Master lookup. `active` flags whether new assignments are allowed. */
export async function listEmployees(search?: string | null): Promise<EmployeeLookupRow[]> {
  const args: any[] = []
  let searchSql = ""
  if (search && search.trim()) {
    const like = `%${search.trim()}%`
    searchSql = ` AND (employee_name LIKE ? OR employee_id LIKE ? OR department LIKE ? OR designation LIKE ?)`
    args.push(like, like, like, like)
  }
  const rows = (await query(
    `SELECT id, employee_id, employee_name, department, designation, employment_status
       FROM hr_employees
      WHERE archived_at IS NULL ${searchSql}
      ORDER BY employee_name ASC
      LIMIT 1000`,
    args,
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    employee_id: r.employee_id ?? null,
    employee_name: r.employee_name ?? null,
    department: r.department ?? null,
    designation: r.designation ?? null,
    employment_status: r.employment_status ?? null,
    active: !INACTIVE_EMPLOYMENT_STATUSES.has(String(r.employment_status ?? "")),
  }))
}

// ── Validation ────────────────────────────────────────────────────────────────

function employeeIsActive(status: string | null | undefined): boolean {
  return !INACTIVE_EMPLOYMENT_STATUSES.has(String(status ?? ""))
}

// ── Assign ────────────────────────────────────────────────────────────────────

export type AssignInput = {
  finance_fixed_asset_id?: string
  employee_id?: number | string
  assignment_date?: string
  expected_return_date?: string | null
  condition_at_assignment?: string | null
  purpose?: string | null
  remarks?: string | null
}

export async function assignAsset(input: AssignInput, session: SessionPayload) {
  await ensureEmployeeAssetSchema()

  const assetId = String(input.finance_fixed_asset_id || "").trim()
  const employeeId = Number(input.employee_id)
  if (!assetId) throw new AssetAssignmentError("Please select an asset.")
  if (!employeeId) throw new AssetAssignmentError("Please select an employee.")

  const assignmentDate = dateOf(input.assignment_date) || today()
  if (!isValidDate(assignmentDate)) throw new AssetAssignmentError("Assignment date is invalid.")
  const expectedReturn = dateOf(input.expected_return_date)
  if (input.expected_return_date && !isValidDate(input.expected_return_date))
    throw new AssetAssignmentError("Expected return date is invalid.")
  if (expectedReturn && expectedReturn < assignmentDate)
    throw new AssetAssignmentError("Expected return date cannot be before the assignment date.")

  // Generate the id up-front (its own connection / transaction, different table).
  const assignmentId = await nextRecordId("EAA", { digits: 6, allowCustom: true })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Lock the asset row and validate assignability.
    const [assetRows] = await conn.query<any[]>(
      `SELECT asset_id, asset_name, asset_category, status FROM fixed_assets WHERE asset_id = ? LIMIT 1 FOR UPDATE`,
      [assetId],
    )
    const asset = assetRows[0]
    if (!asset) throw new AssetAssignmentError("Selected asset no longer exists in Fixed Assets.", 404)
    if (NON_ASSIGNABLE_FINANCE_STATUSES.has(String(asset.status ?? "")))
      throw new AssetAssignmentError(`This asset is ${asset.status} and cannot be assigned.`, 409)

    // Reject if an active assignment already occupies the asset.
    const [active] = await conn.query<any[]>(
      `SELECT id FROM employee_asset_assignments
        WHERE finance_fixed_asset_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")})
        LIMIT 1 FOR UPDATE`,
      [assetId, ...OCCUPYING_STATUSES],
    )
    if (active.length) throw new AssetAssignmentError("Asset is already assigned.", 409)

    // Validate the employee exists and is active.
    const [empRows] = await conn.query<any[]>(
      `SELECT id, employee_id, employee_name, department, employment_status
         FROM hr_employees WHERE id = ? AND archived_at IS NULL LIMIT 1`,
      [employeeId],
    )
    const emp = empRows[0]
    if (!emp) throw new AssetAssignmentError("Selected employee no longer exists.", 404)
    if (!employeeIsActive(emp.employment_status))
      throw new AssetAssignmentError("Cannot assign a new asset to an inactive employee.", 409)

    await conn.query(
      `INSERT INTO employee_asset_assignments
         (assignment_id, finance_fixed_asset_id, employee_id, employee_ref, employee_name, department,
          assignment_date, expected_return_date, condition_at_assignment, purpose, remarks,
          assigned_by, assigned_by_name, status, active_asset_key, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        assignmentId,
        assetId,
        employeeId,
        emp.employee_id ?? null,
        emp.employee_name ?? null,
        emp.department ?? null,
        assignmentDate,
        expectedReturn,
        input.condition_at_assignment ?? null,
        input.purpose ?? null,
        input.remarks ?? null,
        session.userId,
        session.name ?? null,
        "Assigned",
        assetId, // active_asset_key — occupies the asset
        session.userId,
      ],
    )

    await conn.commit()

    await recordAudit({
      assignmentId,
      assetId,
      action: "assigned",
      userId: session.userId,
      userName: session.name,
      newValue: { employee_id: employeeId, status: "Assigned", assignment_date: assignmentDate },
      reason: input.purpose ?? null,
    })
    await notifyEmployee(employeeId, {
      title: "Asset assigned to you",
      body: `${asset.asset_name || asset.asset_id} (${asset.asset_id}) has been assigned to you.`,
      entityId: assignmentId,
    })

    return await getAssignmentDetail(assignmentId)
  } catch (error: any) {
    await conn.rollback().catch(() => {})
    if (error?.code === "ER_DUP_ENTRY") throw new AssetAssignmentError("Asset is already assigned.", 409)
    throw error
  } finally {
    conn.release()
  }
}

// ── Return ──────────────────────────────────────────────────────────────────

export async function returnAsset(
  assignmentId: string,
  input: { return_date?: string | null; condition_at_return?: string | null; return_remarks?: string | null },
  session: SessionPayload,
) {
  await ensureEmployeeAssetSchema()
  const row = await loadAssignment(assignmentId)
  if (!row) throw new AssetAssignmentError("Assignment not found.", 404)
  if (!OCCUPYING_STATUSES.includes(row.status))
    throw new AssetAssignmentError(`This assignment is already ${row.status}.`, 409)

  const returnDate = dateOf(input.return_date) || today()
  if (input.return_date && !isValidDate(input.return_date))
    throw new AssetAssignmentError("Return date is invalid.")
  if (returnDate < dateOf(row.assignment_date)!)
    throw new AssetAssignmentError("Return date cannot be before the assignment date.")

  await query(
    `UPDATE employee_asset_assignments
        SET status = 'Returned', return_date = ?, condition_at_return = ?, return_remarks = ?,
            received_by = ?, received_by_name = ?, active_asset_key = NULL
      WHERE assignment_id = ?`,
    [
      returnDate,
      input.condition_at_return ?? null,
      input.return_remarks ?? null,
      session.userId,
      session.name ?? null,
      assignmentId,
    ],
  )
  await recordAudit({
    assignmentId,
    assetId: row.finance_fixed_asset_id,
    action: "returned",
    userId: session.userId,
    userName: session.name,
    oldValue: { status: row.status },
    newValue: { status: "Returned", return_date: returnDate, condition_at_return: input.condition_at_return ?? null },
    reason: input.return_remarks ?? null,
  })
  await notifyEmployee(row.employee_id, {
    title: "Asset return recorded",
    body: `The return of ${row.finance_fixed_asset_id} has been recorded.`,
    entityId: assignmentId,
  })
  return await getAssignmentDetail(assignmentId)
}

// ── Reassign (return current then assign to a new employee) ────────────────────

export async function reassignAsset(
  assignmentId: string,
  input: AssignInput & { return_condition?: string | null; return_remarks?: string | null },
  session: SessionPayload,
) {
  await ensureEmployeeAssetSchema()
  const current = await loadAssignment(assignmentId)
  if (!current) throw new AssetAssignmentError("Assignment not found.", 404)

  // Close the current assignment (preserving its history) if still active.
  if (OCCUPYING_STATUSES.includes(current.status)) {
    await returnAsset(
      assignmentId,
      {
        return_date: input.assignment_date || today(),
        condition_at_return: input.return_condition ?? null,
        return_remarks: input.return_remarks ?? "Reassigned to another employee",
      },
      session,
    )
  }

  // Create a brand-new assignment for the same asset — history is preserved.
  const detail = await assignAsset(
    {
      finance_fixed_asset_id: current.finance_fixed_asset_id,
      employee_id: input.employee_id,
      assignment_date: input.assignment_date,
      expected_return_date: input.expected_return_date,
      condition_at_assignment: input.condition_at_assignment,
      purpose: input.purpose,
      remarks: input.remarks,
    },
    session,
  )
  await recordAudit({
    assignmentId: detail?.assignment.assignment_id ?? null,
    assetId: current.finance_fixed_asset_id,
    action: "reassigned",
    userId: session.userId,
    userName: session.name,
    oldValue: { from_assignment: assignmentId, from_employee: current.employee_id },
    newValue: { to_employee: Number(input.employee_id) },
  })
  if (input.employee_id)
    await notifyEmployee(Number(input.employee_id), {
      title: "Asset reassigned to you",
      body: `${current.finance_fixed_asset_id} has been reassigned to you.`,
      entityId: detail?.assignment.assignment_id ?? null,
    })
  return detail
}

// ── Mark Lost / Damaged / Under Repair ────────────────────────────────────────

export async function markAssignment(
  assignmentId: string,
  target: "Lost" | "Damaged" | "Under Repair",
  input: { event_date?: string | null; reason?: string | null; remarks?: string | null },
  session: SessionPayload,
) {
  await ensureEmployeeAssetSchema()
  const row = await loadAssignment(assignmentId)
  if (!row) throw new AssetAssignmentError("Assignment not found.", 404)
  if (!OCCUPYING_STATUSES.includes(row.status) && row.status !== "Under Repair")
    throw new AssetAssignmentError(`Cannot change a ${row.status} assignment.`, 409)

  const eventDate = dateOf(input.event_date) || today()
  if (input.event_date && !isValidDate(input.event_date))
    throw new AssetAssignmentError("Event date is invalid.")

  // Under Repair keeps the asset occupied; Lost / Damaged free it (terminal
  // for this assignment) but the asset is NOT put back into the available pool
  // by finance status — availability derives from finance status too.
  const keepsAssetKey = target === "Under Repair"
  await query(
    `UPDATE employee_asset_assignments
        SET status = ?, event_date = ?, event_reason = ?, event_remarks = ?,
            reported_by = ?, reported_by_name = ?, active_asset_key = ?
      WHERE assignment_id = ?`,
    [
      target,
      eventDate,
      input.reason ?? null,
      input.remarks ?? null,
      session.userId,
      session.name ?? null,
      keepsAssetKey ? row.finance_fixed_asset_id : null,
      assignmentId,
    ],
  )
  const actionMap = { Lost: "marked_lost", Damaged: "marked_damaged", "Under Repair": "under_repair" } as const
  await recordAudit({
    assignmentId,
    assetId: row.finance_fixed_asset_id,
    action: actionMap[target],
    userId: session.userId,
    userName: session.name,
    oldValue: { status: row.status },
    newValue: { status: target, event_date: eventDate },
    reason: input.reason ?? null,
  })
  await notifyEmployee(row.employee_id, {
    title: `Asset marked ${target}`,
    body: `${row.finance_fixed_asset_id} has been marked ${target}.`,
    entityId: assignmentId,
  })
  return await getAssignmentDetail(assignmentId)
}

// ── Update assignment metadata ────────────────────────────────────────────────

const EDITABLE = new Set([
  "assignment_date",
  "expected_return_date",
  "condition_at_assignment",
  "purpose",
  "remarks",
])

export async function updateAssignment(
  assignmentId: string,
  input: Record<string, any>,
  session: SessionPayload,
) {
  await ensureEmployeeAssetSchema()
  const row = await loadAssignment(assignmentId)
  if (!row) throw new AssetAssignmentError("Assignment not found.", 404)

  const data: Record<string, any> = {}
  for (const k of EDITABLE) if (k in input) data[k] = input[k] === "" ? null : input[k]
  if ("assignment_date" in data && !isValidDate(data.assignment_date))
    throw new AssetAssignmentError("Assignment date is invalid.")
  if (data.expected_return_date && !isValidDate(data.expected_return_date))
    throw new AssetAssignmentError("Expected return date is invalid.")
  const cols = Object.keys(data)
  if (cols.length === 0) return await getAssignmentDetail(assignmentId)

  await query(
    `UPDATE employee_asset_assignments SET ${cols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE assignment_id = ?`,
    [...cols.map((c) => data[c]), assignmentId],
  )
  await recordAudit({
    assignmentId,
    assetId: row.finance_fixed_asset_id,
    action: "assignment_updated",
    userId: session.userId,
    userName: session.name,
    oldValue: Object.fromEntries(cols.map((c) => [c, row[c]])),
    newValue: data,
  })
  return await getAssignmentDetail(assignmentId)
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function loadAssignment(assignmentId: string): Promise<any | null> {
  const [row] = (await query(
    `SELECT * FROM employee_asset_assignments WHERE assignment_id = ? LIMIT 1`,
    [assignmentId],
  )) as any[]
  return row ?? null
}

/**
 * Derive an effective status by combining the assignment status with the live
 * finance asset status (Phase 30 / auto-status). A closed finance asset forces
 * the assignment to read as "Disposed" regardless of the stored value.
 */
function deriveStatus(assignmentStatus: string, financeStatus: string | null): string {
  if (CLOSED_FINANCE_STATUSES.has(String(financeStatus ?? "")) && assignmentStatus === "Assigned")
    return "Disposed"
  return assignmentStatus
}

export type AssignmentListParams = {
  search?: string | null
  status?: string | null
  employee_id?: string | null
  department?: string | null
  asset_type?: string | null
  date_from?: string | null
  date_to?: string | null
  return_from?: string | null
  return_to?: string | null
  pending_recovery?: boolean
}

export async function listAssignments(params: AssignmentListParams, session: SessionPayload) {
  await ensureEmployeeAssetSchema()
  await reconcileClosedAssets()

  const where: string[] = []
  const args: any[] = []

  if (params.search && params.search.trim()) {
    const like = `%${params.search.trim()}%`
    where.push(
      `(a.assignment_id LIKE ? OR a.finance_fixed_asset_id LIKE ? OR a.employee_name LIKE ? OR a.employee_ref LIKE ? OR fa.asset_name LIKE ?)`,
    )
    args.push(like, like, like, like, like)
  }
  if (params.status) {
    where.push(`a.status = ?`)
    args.push(params.status)
  }
  if (params.employee_id) {
    where.push(`a.employee_id = ?`)
    args.push(Number(params.employee_id))
  }
  if (params.department) {
    where.push(`a.department = ?`)
    args.push(params.department)
  }
  if (params.asset_type) {
    where.push(`fa.asset_type = ?`)
    args.push(params.asset_type)
  }
  if (params.date_from) {
    where.push(`a.assignment_date >= ?`)
    args.push(params.date_from)
  }
  if (params.date_to) {
    where.push(`a.assignment_date <= ?`)
    args.push(params.date_to)
  }
  if (params.return_from) {
    where.push(`a.return_date >= ?`)
    args.push(params.return_from)
  }
  if (params.return_to) {
    where.push(`a.return_date <= ?`)
    args.push(params.return_to)
  }
  if (params.pending_recovery) {
    where.push(
      `a.status IN ('Assigned','Under Repair') AND EXISTS (
         SELECT 1 FROM hr_employees e WHERE e.id = a.employee_id
           AND (e.archived_at IS NOT NULL OR e.employment_status IN (${Array.from(INACTIVE_EMPLOYMENT_STATUSES)
             .map(() => "?")
             .join(",")}))
       )`,
    )
    args.push(...Array.from(INACTIVE_EMPLOYMENT_STATUSES))
  }

  // Record-level permission scope (admins / unconfigured users unrestricted).
  const scoped = await scopeWhereForModule(session, PERMISSION_KEY, "view", "employee_asset_assignments", "a")
  if (scoped) {
    where.push(scoped.sql)
    args.push(...scoped.params)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = (await query(
    `SELECT a.*, fa.asset_name, fa.asset_category, fa.asset_type, fa.status AS finance_status,
            fa.net_book_value, fa.cost, fa.capitalised_cost,
            e.employment_status AS employee_employment_status, e.archived_at AS employee_archived_at
       FROM employee_asset_assignments a
       LEFT JOIN fixed_assets fa ON fa.asset_id = a.finance_fixed_asset_id
       LEFT JOIN hr_employees e ON e.id = a.employee_id
       ${whereSql}
      ORDER BY a.id DESC
      LIMIT 2000`,
    args,
  )) as any[]

  const list = rows.map((r) => ({
    ...r,
    effective_status: deriveStatus(String(r.status), r.finance_status),
    pending_recovery:
      OCCUPYING_STATUSES.includes(String(r.status) as AssignmentStatus) &&
      (r.employee_archived_at != null || INACTIVE_EMPLOYMENT_STATUSES.has(String(r.employee_employment_status ?? ""))),
  }))

  const summary = await dashboardSummary()
  return { rows: list, summary }
}

/** Dashboard counts — every number comes from real rows. */
export async function dashboardSummary() {
  await ensureEmployeeAssetSchema()
  const nonAssignable = Array.from(NON_ASSIGNABLE_FINANCE_STATUSES)

  const [assignmentAgg] = (await query(
    `SELECT
        SUM(status = 'Assigned') AS assigned,
        SUM(status = 'Returned') AS returned,
        SUM(status = 'Lost') AS lost,
        SUM(status = 'Damaged') AS damaged,
        SUM(status = 'Under Repair') AS under_repair
       FROM employee_asset_assignments`,
  )) as any[]

  const [assetAgg] = (await query(`SELECT COUNT(*) AS total FROM fixed_assets`)) as any[]

  const [availableAgg] = (await query(
    `SELECT COUNT(*) AS available FROM fixed_assets fa
      WHERE (fa.status IS NULL OR fa.status NOT IN (${nonAssignable.map(() => "?").join(",")}))
        AND NOT EXISTS (
          SELECT 1 FROM employee_asset_assignments a
           WHERE a.finance_fixed_asset_id = fa.asset_id AND a.status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")})
        )`,
    [...nonAssignable, ...OCCUPYING_STATUSES],
  )) as any[]

  const [recoveryAgg] = (await query(
    `SELECT COUNT(*) AS pending_recovery
       FROM employee_asset_assignments a
       JOIN hr_employees e ON e.id = a.employee_id
      WHERE a.status IN ('Assigned','Under Repair')
        AND (e.archived_at IS NOT NULL OR e.employment_status IN (${Array.from(INACTIVE_EMPLOYMENT_STATUSES)
          .map(() => "?")
          .join(",")}))`,
    Array.from(INACTIVE_EMPLOYMENT_STATUSES),
  )) as any[]

  return {
    total_assets: num(assetAgg?.total),
    available: num(availableAgg?.available),
    assigned: num(assignmentAgg?.assigned),
    returned: num(assignmentAgg?.returned),
    lost: num(assignmentAgg?.lost),
    damaged: num(assignmentAgg?.damaged),
    under_repair: num(assignmentAgg?.under_repair),
    pending_recovery: num(recoveryAgg?.pending_recovery),
  }
}

/** Full detail for one assignment + the finance asset + its assignment history. */
export async function getAssignmentDetail(assignmentId: string) {
  await ensureEmployeeAssetSchema()
  const [row] = (await query(
    `SELECT a.*, fa.asset_name, fa.asset_category, fa.asset_type, fa.status AS finance_status,
            fa.net_book_value, fa.cost, fa.capitalised_cost, fa.location, fa.custodian, fa.vendor,
            fa.acquisition_date, fa.id AS finance_row_id
       FROM employee_asset_assignments a
       LEFT JOIN fixed_assets fa ON fa.asset_id = a.finance_fixed_asset_id
      WHERE a.assignment_id = ? LIMIT 1`,
    [assignmentId],
  )) as any[]
  if (!row) return null

  const history = await assetAssignmentHistory(row.finance_fixed_asset_id)
  const audit = (await query(
    `SELECT action, user_name, old_value, new_value, reason, created_at
       FROM employee_asset_audit WHERE assignment_id = ? ORDER BY id DESC LIMIT 100`,
    [assignmentId],
  )) as any[]

  return {
    assignment: { ...row, effective_status: deriveStatus(String(row.status), row.finance_status) },
    history,
    audit,
  }
}

/** Complete assignment history for a finance fixed asset. */
export async function assetAssignmentHistory(assetId: string) {
  await ensureEmployeeAssetSchema()
  return (await query(
    `SELECT assignment_id, employee_id, employee_name, employee_ref, department,
            assignment_date, return_date, condition_at_assignment, condition_at_return, status
       FROM employee_asset_assignments
      WHERE finance_fixed_asset_id = ?
      ORDER BY id DESC`,
    [assetId],
  )) as any[]
}

/** All assignments for one employee (current + returned + lost/damaged history). */
export async function employeeAssignments(employeeId: number) {
  await ensureEmployeeAssetSchema()
  await reconcileClosedAssets()
  const rows = (await query(
    `SELECT a.*, fa.asset_name, fa.asset_category, fa.asset_type, fa.status AS finance_status
       FROM employee_asset_assignments a
       LEFT JOIN fixed_assets fa ON fa.asset_id = a.finance_fixed_asset_id
      WHERE a.employee_id = ?
      ORDER BY a.id DESC`,
    [employeeId],
  )) as any[]
  return rows.map((r) => ({ ...r, effective_status: deriveStatus(String(r.status), r.finance_status) }))
}

// ── Finance sync (Phase 17 / 30) ──────────────────────────────────────────────

/**
 * Reconcile assignments whose underlying finance asset has become terminal
 * (Disposed / Scrapped / Archived): close the active assignment as "Disposed"
 * so Employee Assets always reflects Finance. Idempotent — only touches
 * still-active rows. Runs cheaply on every list load and in the cron.
 */
export async function reconcileClosedAssets(): Promise<number> {
  const closed = Array.from(CLOSED_FINANCE_STATUSES)
  const stale = (await query(
    `SELECT a.assignment_id, a.finance_fixed_asset_id, a.status, fa.status AS finance_status
       FROM employee_asset_assignments a
       JOIN fixed_assets fa ON fa.asset_id = a.finance_fixed_asset_id
      WHERE a.status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")})
        AND fa.status IN (${closed.map(() => "?").join(",")})`,
    [...OCCUPYING_STATUSES, ...closed],
  ).catch(() => [])) as any[]

  for (const s of stale) {
    await query(
      `UPDATE employee_asset_assignments
          SET status = 'Disposed', active_asset_key = NULL, event_date = COALESCE(event_date, ?),
              event_reason = COALESCE(event_reason, ?)
        WHERE assignment_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")})`,
      [today(), `Finance asset ${s.finance_status}`, s.assignment_id, ...OCCUPYING_STATUSES],
    ).catch(() => {})
    await recordAudit({
      assignmentId: s.assignment_id,
      assetId: s.finance_fixed_asset_id,
      action: "finance_sync_disposed",
      oldValue: { status: s.status },
      newValue: { status: "Disposed" },
      reason: `Finance asset became ${s.finance_status}`,
    })
  }
  return stale.length
}

// ── Export (Phase 35) ─────────────────────────────────────────────────────────

export function assignmentsToCsv(rows: any[]): string {
  const headers = [
    "Assignment ID",
    "Asset ID",
    "Asset Name",
    "Employee",
    "Department",
    "Assigned Date",
    "Return Date",
    "Status",
    "Condition",
  ]
  const esc = (v: any) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.assignment_id,
        r.finance_fixed_asset_id,
        r.asset_name,
        r.employee_name,
        r.department,
        dateOf(r.assignment_date),
        dateOf(r.return_date),
        r.effective_status ?? r.status,
        r.condition_at_return || r.condition_at_assignment,
      ]
        .map(esc)
        .join(","),
    )
  }
  return lines.join("\n")
}

// ── Reminders (Phase 36–39) ────────────────────────────────────────────────────

/**
 * Return-due / overdue / recovery reminders. Deduped per assignment + bucket so
 * repeated cron runs never re-notify. Returns counts for observability.
 */
export async function runAssetReminders(asOfInput?: string | null) {
  await ensureEmployeeAssetSchema()
  await reconcileClosedAssets()
  const { emitReminder } = await import("@/lib/finance-automation-shared")
  const asOf = (asOfInput || today()).slice(0, 10)

  const rows = (await query(
    `SELECT a.assignment_id, a.finance_fixed_asset_id, a.employee_id, a.employee_name,
            a.expected_return_date, a.status, e.user_id, e.employment_status, e.archived_at
       FROM employee_asset_assignments a
       JOIN hr_employees e ON e.id = a.employee_id
      WHERE a.status IN ('Assigned','Under Repair')`,
  ).catch(() => [])) as any[]

  let dueSoon = 0
  let overdue = 0
  let recovery = 0
  let notifications = 0

  for (const r of rows) {
    const userId = r.user_id ? Number(r.user_id) : null
    const recipients = userId ? [userId] : []
    const assetLabel = r.finance_fixed_asset_id

    // Offboarding / inactive-employee recovery alert.
    const inactive =
      r.archived_at != null || INACTIVE_EMPLOYMENT_STATUSES.has(String(r.employment_status ?? ""))
    if (inactive) {
      recovery += 1
      notifications += await emitReminder(
        {
          key: `eaa-recovery:${r.assignment_id}`,
          type: "employee-asset",
          title: `Asset recovery pending: ${assetLabel}`,
          body: `${assetLabel} is still held by ${r.employee_name || "an inactive employee"}. Recover the asset.`,
          link: MODULE_LINK,
          entityType: "employee_asset_assignment",
          entityId: r.assignment_id,
        },
        recipients,
      )
      continue
    }

    const due = dateOf(r.expected_return_date)
    if (!due) continue
    const daysToDue = Math.floor((Date.parse(due) - Date.parse(asOf)) / 86_400_000)
    if (daysToDue < 0) {
      overdue += 1
      notifications += await emitReminder(
        {
          key: `eaa-overdue:${r.assignment_id}:${due}`,
          type: "employee-asset",
          title: `Asset return overdue: ${assetLabel}`,
          body: `${assetLabel} was due back on ${due}. Please return it.`,
          link: MODULE_LINK,
          entityType: "employee_asset_assignment",
          entityId: r.assignment_id,
        },
        recipients,
      )
    } else if (daysToDue <= 3) {
      dueSoon += 1
      notifications += await emitReminder(
        {
          key: `eaa-due:${r.assignment_id}:${due}`,
          type: "employee-asset",
          title: `Asset return due soon: ${assetLabel}`,
          body: `${assetLabel} is due back on ${due}.`,
          link: MODULE_LINK,
          entityType: "employee_asset_assignment",
          entityId: r.assignment_id,
        },
        recipients,
      )
    }
  }

  return { ran_at: new Date().toISOString(), as_of: asOf, due_soon: dueSoon, overdue, recovery, notifications }
}
