import { query } from "@/lib/db"
import { logEmployeeEvent } from "@/lib/hr-employee-events"

// ---------------------------------------------------------------------------
// HR Offboarding domain helpers.
//
// Offboarding is an exit *workflow* layered on top of existing ERP masters
// (Employees, Attendance, Leaves, Documents, Letters, Support). This module
// owns the offboarding-specific schema, lifecycle constants, notice-period
// math, the case timeline, and the completion gate. It never duplicates
// employee/asset/payroll masters — it references them.
// ---------------------------------------------------------------------------

export const OFFBOARDING_STATUSES = [
  "Initiated",
  "Notice Period",
  "Clearance Pending",
  "Settlement Pending",
  "Exit Pending",
  "Completed",
  "On Hold",
  "Cancelled",
  "Withdrawn",
] as const
export type OffboardingStatus = (typeof OFFBOARDING_STATUSES)[number]

/** Statuses that mean the case is closed and the employee is no longer exiting. */
export const CLOSED_STATUSES: OffboardingStatus[] = ["Completed", "Cancelled", "Withdrawn"]

/** Default exit types. HR Master Data has no dedicated exit-type table today,
 *  so these act as the configurable list surfaced in the UI. */
export const EXIT_TYPES = [
  "Resignation",
  "Termination",
  "Retirement",
  "Contract End",
  "Absconded",
  "Mutual Separation",
  "Other",
] as const

export const CLEARANCE_DEPARTMENTS = ["Reporting Manager", "HR", "Finance", "IT", "Admin"] as const
export const CLEARANCE_STATUSES = ["Pending", "In Progress", "Cleared", "Rejected", "Not Applicable"] as const
export type ClearanceStatus = (typeof CLEARANCE_STATUSES)[number]

export const ASSET_RETURN_STATUSES = ["Issued", "Return Pending", "Returned", "Damaged", "Lost", "Not Applicable"] as const

export const SETTLEMENT_STATUSES = [
  "Not Started",
  "Pending Calculation",
  "Pending Review",
  "Approved",
  "Processed",
  "Completed",
  "On Hold",
] as const

export const KT_STATUSES = ["Not Applicable", "Pending", "In Progress", "Completed"] as const
export const REHIRE_OPTIONS = ["Eligible", "Not Eligible", "Review Required"] as const

// Components that make up a full & final settlement. Offboarding only records
// and aggregates these figures — there is no payroll engine in the ERP, so the
// coordinator enters the numbers and the total is recomputed server-side.
export const SETTLEMENT_COMPONENTS: { key: string; label: string; sign: 1 | -1 }[] = [
  { key: "salary_payable", label: "Salary payable till LWD", sign: 1 },
  { key: "leave_encashment", label: "Leave encashment", sign: 1 },
  { key: "notice_pay", label: "Notice pay", sign: 1 },
  { key: "reimbursements", label: "Reimbursements", sign: 1 },
  { key: "other_payable", label: "Other payable", sign: 1 },
  { key: "notice_recovery", label: "Notice recovery", sign: -1 },
  { key: "loans", label: "Loans", sign: -1 },
  { key: "advances", label: "Advances", sign: -1 },
  { key: "asset_recovery", label: "Asset recovery", sign: -1 },
  { key: "deductions", label: "Other deductions", sign: -1 },
]

export function settlementTotal(breakdown: Record<string, unknown> | null | undefined): number {
  if (!breakdown) return 0
  let total = 0
  for (const c of SETTLEMENT_COMPONENTS) {
    const raw = Number(breakdown[c.key])
    if (Number.isFinite(raw)) total += c.sign * raw
  }
  return Math.round(total * 100) / 100
}

// ---------------------------------------------------------------------------
// Schema — ensured lazily at runtime, mirroring ensureEmployeeEventsSchema so
// the feature works before the SQL migration is applied by hand. Additive
// only: never drops or rewrites existing offboarding data.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null
export function ensureOffboardingSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  // The original table exists (2026-09-01 migration). Relax the status ENUM to
  // a VARCHAR so the richer lifecycle values are accepted.
  try {
    await query("ALTER TABLE hr_offboarding MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'Initiated'")
  } catch {
    // ENUM already relaxed, or server rejected a no-op modify.
  }

  const columns = [
    "ADD COLUMN IF NOT EXISTS `notice_period_days` INT DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `expected_last_working_date` DATE DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `support_document` VARCHAR(255) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `settlement_status` VARCHAR(40) NOT NULL DEFAULT 'Not Started'",
    "ADD COLUMN IF NOT EXISTS `settlement_amount` DECIMAL(14,2) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `settlement_breakdown` JSON DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `settlement_notes` TEXT DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `settlement_approved_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `settlement_approved_at` DATETIME DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `kt_status` VARCHAR(30) NOT NULL DEFAULT 'Not Applicable'",
    "ADD COLUMN IF NOT EXISTS `kt_handover_to` VARCHAR(150) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `kt_notes` TEXT DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `kt_completed_at` DATETIME DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `exit_interview_status` VARCHAR(30) NOT NULL DEFAULT 'Pending'",
    "ADD COLUMN IF NOT EXISTS `exit_interview_data` JSON DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `rehire_eligibility` VARCHAR(30) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `rehire_reason` VARCHAR(255) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `previous_employment_status` VARCHAR(80) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `created_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `completed_at` DATETIME DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `completed_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `cancelled_at` DATETIME DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `cancelled_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `cancel_reason` VARCHAR(255) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `override_used` TINYINT(1) NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS `override_reason` VARCHAR(255) DEFAULT NULL",
  ]
  for (const col of columns) {
    try {
      await query(`ALTER TABLE hr_offboarding ${col}`)
    } catch {
      // Column already present on servers without IF NOT EXISTS support.
    }
  }

  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_offboarding_clearances (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      offboarding_id BIGINT UNSIGNED NOT NULL,
      department VARCHAR(60) NOT NULL,
      responsible_name VARCHAR(150) DEFAULT NULL,
      responsible_user_id INT UNSIGNED DEFAULT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      is_mandatory TINYINT(1) NOT NULL DEFAULT 1,
      started_at DATETIME DEFAULT NULL,
      completed_at DATETIME DEFAULT NULL,
      comments TEXT DEFAULT NULL,
      rejection_reason VARCHAR(255) DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_off_clearance_case (offboarding_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS hr_offboarding_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      offboarding_id BIGINT UNSIGNED NOT NULL,
      asset_name VARCHAR(150) NOT NULL,
      asset_code VARCHAR(80) DEFAULT NULL,
      assigned_date DATE DEFAULT NULL,
      return_status VARCHAR(30) NOT NULL DEFAULT 'Return Pending',
      asset_condition VARCHAR(120) DEFAULT NULL,
      return_date DATE DEFAULT NULL,
      remarks VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_off_asset_case (offboarding_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS hr_offboarding_timeline (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      offboarding_id BIGINT UNSIGNED NOT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      details JSON DEFAULT NULL,
      actor_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_off_timeline_case (offboarding_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureOffboardingSchema (tables) failed:", (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Notice-period math
// ---------------------------------------------------------------------------

/** Parse an employee's stored notice period (e.g. "30 days", "2 months", "60")
 *  into a number of days. Returns null when it can't be derived. */
export function parseNoticeDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim().toLowerCase()
  if (!text) return null
  const num = Number.parseFloat(text.replace(/[^0-9.]/g, ""))
  if (!Number.isFinite(num) || num <= 0) return null
  if (text.includes("month")) return Math.round(num * 30)
  if (text.includes("week")) return Math.round(num * 7)
  return Math.round(num)
}

/** noticeDate + days => expected last working date (YYYY-MM-DD). */
export function addDays(dateStr: string | null | undefined, days: number | null | undefined): string | null {
  if (!dateStr || days === null || days === undefined) return null
  const base = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(base.getTime())) return null
  base.setDate(base.getDate() + days)
  return base.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Timeline + cross-module audit
// ---------------------------------------------------------------------------

export async function logOffboardingEvent(opts: {
  offboardingId: number
  employeeId?: number | null
  employeeRef?: string | null
  employeeName?: string | null
  eventType: string
  summary: string
  details?: Record<string, unknown> | null
  actorId?: number | null
  actorName?: string | null
  mirrorToEmployee?: boolean
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_offboarding_timeline (offboarding_id, event_type, summary, details, actor_id, actor_name)
       VALUES (?,?,?,?,?,?)`,
      [
        opts.offboardingId,
        opts.eventType,
        opts.summary,
        opts.details ? JSON.stringify(opts.details) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logOffboardingEvent failed:", (error as Error).message)
  }
  // Mirror significant events onto the employee's own audit/timeline so the
  // employee 360 view stays coherent — reusing the existing audit system.
  if (opts.mirrorToEmployee && opts.employeeId) {
    await logEmployeeEvent({
      employeeId: opts.employeeId,
      employeeRef: opts.employeeRef ?? null,
      employeeName: opts.employeeName ?? null,
      type: "updated",
      summary: `Offboarding: ${opts.summary}`,
      actorId: opts.actorId ?? null,
      actorName: opts.actorName ?? null,
    })
  }
}

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

export type GateItem = { key: string; label: string; ok: boolean; mandatory: boolean; detail: string }

/** Build the exit-completion checklist from the aggregated case data. Mandatory
 *  failing items block completion unless an authorized override is supplied. */
export function buildCompletionChecklist(input: {
  caseRow: any
  clearances: any[]
  assets: any[]
  pendingRegularisations: number
  pendingLeaveRequests: number
  openTickets: number
}): GateItem[] {
  const { caseRow, clearances, assets, pendingRegularisations, pendingLeaveRequests, openTickets } = input

  const mandatoryClearances = clearances.filter((c) => c.is_mandatory)
  const clearancesDone = mandatoryClearances.every((c) => c.status === "Cleared" || c.status === "Not Applicable")
  const clearancesRejected = clearances.some((c) => c.status === "Rejected")
  const assetsDone = assets.every((a) => a.return_status === "Returned" || a.return_status === "Not Applicable")
  const settlementDone = ["Approved", "Processed", "Completed"].includes(caseRow.settlement_status)
  const ktDone = caseRow.kt_status === "Completed" || caseRow.kt_status === "Not Applicable"

  const pendingAssetCount = assets.filter(
    (a) => a.return_status !== "Returned" && a.return_status !== "Not Applicable",
  ).length
  const pendingClearanceCount = mandatoryClearances.filter(
    (c) => c.status !== "Cleared" && c.status !== "Not Applicable",
  ).length

  return [
    {
      key: "lwd",
      label: "Final last working date confirmed",
      ok: Boolean(caseRow.last_working_date),
      mandatory: true,
      detail: caseRow.last_working_date ? String(caseRow.last_working_date).slice(0, 10) : "Not set",
    },
    {
      key: "clearances",
      label: "Mandatory clearances completed",
      ok: clearancesDone && !clearancesRejected,
      mandatory: true,
      detail: clearancesRejected
        ? "A clearance was rejected"
        : `${mandatoryClearances.length - pendingClearanceCount}/${mandatoryClearances.length} cleared`,
    },
    {
      key: "assets",
      label: "Company assets returned",
      ok: assetsDone,
      mandatory: true,
      detail: assets.length ? `${assets.length - pendingAssetCount}/${assets.length} returned` : "No assets tracked",
    },
    {
      key: "settlement",
      label: "Final settlement approved/processed",
      ok: settlementDone,
      mandatory: true,
      detail: caseRow.settlement_status || "Not Started",
    },
    {
      key: "regularisation",
      label: "No pending attendance regularisation",
      ok: pendingRegularisations === 0,
      mandatory: true,
      detail: pendingRegularisations ? `${pendingRegularisations} pending` : "Clear",
    },
    {
      key: "leave",
      label: "No pending leave requests",
      ok: pendingLeaveRequests === 0,
      mandatory: false,
      detail: pendingLeaveRequests ? `${pendingLeaveRequests} pending` : "Clear",
    },
    {
      key: "knowledge_transfer",
      label: "Knowledge transfer completed",
      ok: ktDone,
      mandatory: false,
      detail: caseRow.kt_status || "Not Applicable",
    },
    {
      key: "support",
      label: "No open HR support tickets",
      ok: openTickets === 0,
      mandatory: false,
      detail: openTickets ? `${openTickets} open` : "Clear",
    },
  ]
}

export function gateBlocked(items: GateItem[]): GateItem[] {
  return items.filter((i) => i.mandatory && !i.ok)
}
