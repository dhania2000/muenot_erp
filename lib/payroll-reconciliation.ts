import "server-only"
import { query, tableColumns } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"
import { recordAuditLog } from "@/lib/audit-log-store"
import { normaliseToHourly } from "@/lib/operations-resource-management"
import {
  isValidPeriod,
  reconcilePayroll,
  validateTaxSlabs,
  type AttendanceDay,
  type TaxSlab,
  type TimesheetDay,
} from "@/lib/payroll-reconciliation-core"

// SPEC 44 (#203) — DB side of payroll reconciliation. Reads attendance and
// APPROVED timesheets for one period, reconciles them via the pure core, and
// persists a tenant-scoped, idempotent run that can be finalized (locked).

const TABLE = "hr_payroll_runs"

let ensured: Promise<void> | null = null
export function ensurePayrollSchema(): Promise<void> {
  if (!ensured) {
    ensured = Promise.resolve(
      query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED DEFAULT NULL,
        period CHAR(7) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'Draft',
        idempotency_key VARCHAR(120) DEFAULT NULL,
        employee_count INT UNSIGNED NOT NULL DEFAULT 0,
        gross DECIMAL(14,2) NOT NULL DEFAULT 0,
        tax_withheld DECIMAL(14,2) NOT NULL DEFAULT 0,
        net DECIMAL(14,2) NOT NULL DEFAULT 0,
        unreconciled_count INT UNSIGNED NOT NULL DEFAULT 0,
        tax_slabs JSON DEFAULT NULL,
        lines JSON DEFAULT NULL,
        created_by INT UNSIGNED DEFAULT NULL,
        finalized_by INT UNSIGNED DEFAULT NULL,
        finalized_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payroll_run_idem (tenant_id, idempotency_key),
        KEY idx_payroll_run_period (tenant_id, period)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`),
    ).then(() => undefined)
    ensured.catch(() => {
      ensured = null
    })
  }
  return ensured
}

function tenantId(): number | null {
  return getCurrentTenant()?.tenantId ?? null
}

function monthBounds(period: string): [string, string] {
  const [y, m] = period.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [`${period}-01`, `${period}-${String(last).padStart(2, "0")}`]
}

async function loadInputs(period: string) {
  const [from, to] = monthBounds(period)
  const attendance = await query<any[]>(
    `SELECT employee_id, employee_name, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, working_hours, status
       FROM hr_attendance WHERE work_date BETWEEN ? AND ?`,
    [from, to],
  ).catch(() => [] as any[])

  const resCols = await tableColumns("operations_resources").catch(() => new Set<string>())
  const resourceToEmployee = new Map<string, string>()
  const rateByEmployee = new Map<string, number>()
  if (resCols.has("employee_id") && resCols.has("resource_id")) {
    const rows = await query<any[]>(
      `SELECT resource_id, employee_id${resCols.has("cost_rate") ? ", cost_rate" : ""}${resCols.has("rate_type") ? ", rate_type" : ""}
         FROM operations_resources WHERE employee_id IS NOT NULL`,
    ).catch(() => [] as any[])
    for (const r of rows) {
      const emp = String(r.employee_id)
      resourceToEmployee.set(String(r.resource_id), emp)
      rateByEmployee.set(emp, normaliseToHourly(r.cost_rate, r.rate_type))
    }
  }

  const tsCols = await tableColumns("operations_timesheets").catch(() => new Set<string>())
  const approvalFilter = tsCols.has("approval_status") ? " AND approval_status = 'Approved'" : ""
  const tsRows = tsCols.has("resource_id")
    ? await query<any[]>(
        `SELECT resource_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, hours_worked
           FROM operations_timesheets WHERE work_date BETWEEN ? AND ?${approvalFilter}`,
        [from, to],
      ).catch(() => [] as any[])
    : []

  const timesheets: TimesheetDay[] = []
  for (const t of tsRows) {
    const emp = resourceToEmployee.get(String(t.resource_id))
    if (emp) timesheets.push({ employee_id: emp, work_date: t.work_date, hours: Number(t.hours_worked) || 0 })
  }
  const att: AttendanceDay[] = attendance.map((a) => ({
    employee_id: String(a.employee_id),
    employee_name: a.employee_name,
    work_date: a.work_date,
    working_hours: Number(a.working_hours) || 0,
    status: String(a.status ?? "Present"),
  }))
  return { attendance: att, timesheets, rateOf: (id: string) => rateByEmployee.get(id) ?? 0 }
}

export async function previewPayroll(period: string, slabs?: unknown) {
  if (!isValidPeriod(period)) throw new Error("Period must be YYYY-MM.")
  const taxSlabs: TaxSlab[] | undefined = slabs ? validateTaxSlabs(slabs) : undefined
  const inputs = await loadInputs(period)
  return reconcilePayroll(inputs.attendance, inputs.timesheets, { period, rateOf: inputs.rateOf, slabs: taxSlabs })
}

function hydrate(row: any) {
  if (!row) return null
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v)
  return { ...row, lines: parse(row.lines) ?? [], tax_slabs: parse(row.tax_slabs) }
}

export async function listPayrollRuns(period?: string) {
  await ensurePayrollSchema()
  const where = ["(tenant_id <=> ?)"]
  const args: unknown[] = [tenantId()]
  if (period && isValidPeriod(period)) {
    where.push("period = ?")
    args.push(period)
  }
  const rows = await query<any[]>(
    `SELECT id, period, status, employee_count, gross, tax_withheld, net, unreconciled_count, created_at, finalized_at
       FROM ${TABLE} WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 100`,
    args,
  )
  return rows
}

export async function getPayrollRun(id: number) {
  await ensurePayrollSchema()
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} WHERE id = ? AND (tenant_id <=> ?) LIMIT 1`, [id, tenantId()])
  return hydrate(rows[0])
}

type Actor = { userId: number }

/** Create a Draft run. Same idempotency key → the existing run (no duplicate). */
export async function createPayrollRun(
  input: { period: string; tax_slabs?: unknown; idempotency_key?: string },
  actor: Actor,
) {
  await ensurePayrollSchema()
  const tid = tenantId()
  const key = input.idempotency_key ? String(input.idempotency_key).slice(0, 120) : null
  if (key) {
    const existing = await query<any[]>(
      `SELECT * FROM ${TABLE} WHERE (tenant_id <=> ?) AND idempotency_key = ? LIMIT 1`,
      [tid, key],
    )
    if (existing[0]) return { run: hydrate(existing[0]), duplicate: true }
  }
  const finalized = await query<any[]>(
    `SELECT id FROM ${TABLE} WHERE (tenant_id <=> ?) AND period = ? AND status = 'Finalized' LIMIT 1`,
    [tid, input.period],
  )
  if (finalized[0]) throw new Error(`Payroll for ${input.period} is already finalized.`)

  const { lines, summary } = await previewPayroll(input.period, input.tax_slabs)
  const result: any = await query(
    `INSERT INTO ${TABLE} (tenant_id, period, status, idempotency_key, employee_count, gross, tax_withheld, net,
       unreconciled_count, tax_slabs, lines, created_by) VALUES (?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tid,
      input.period,
      key,
      summary.employeeCount,
      summary.gross,
      summary.taxWithheld,
      summary.net,
      summary.unreconciledCount,
      input.tax_slabs ? JSON.stringify(validateTaxSlabs(input.tax_slabs)) : null,
      JSON.stringify(lines),
      actor.userId,
    ],
  )
  const run = await getPayrollRun(Number(result.insertId))
  await recordAuditLog({
    action: "payroll_run.create",
    entityType: "hr_payroll_run",
    entityId: run?.id,
    entityLabel: input.period,
    after: summary,
  })
  return { run, duplicate: false }
}

/** Lock a Draft run. Refuses while any line is unreconciled unless forced with a reason. */
export async function finalizePayrollRun(id: number, actor: Actor, opts: { force?: boolean; reason?: string } = {}) {
  const run = await getPayrollRun(id)
  if (!run) throw new Error("Payroll run not found.")
  if (run.status === "Finalized") return run
  if (Number(run.unreconciled_count) > 0 && !(opts.force && opts.reason?.trim())) {
    throw new Error(
      `${run.unreconciled_count} employee(s) have unreconciled attendance/timesheet days. Resolve them or finalize with a reason.`,
    )
  }
  const other = await query<any[]>(
    `SELECT id FROM ${TABLE} WHERE (tenant_id <=> ?) AND period = ? AND status = 'Finalized' AND id <> ? LIMIT 1`,
    [tenantId(), run.period, id],
  )
  if (other[0]) throw new Error(`Payroll for ${run.period} is already finalized.`)
  await query(
    `UPDATE ${TABLE} SET status = 'Finalized', finalized_by = ?, finalized_at = NOW() WHERE id = ? AND status = 'Draft'`,
    [actor.userId, id],
  )
  await recordAuditLog({
    action: "payroll_run.finalize",
    entityType: "hr_payroll_run",
    entityId: id,
    entityLabel: run.period,
    before: { status: run.status },
    after: { status: "Finalized" },
    metadata: { forced: Boolean(opts.force), reason: opts.reason ?? null },
  })
  return getPayrollRun(id)
}
