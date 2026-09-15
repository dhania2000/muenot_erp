import "server-only"
import { query } from "@/lib/db"

/**
 * Financial Report run log (Phases 18–20).
 *
 * Every time a report is generated for keeps — viewed on screen, downloaded
 * (PDF / Excel / CSV) or emailed — one immutable row is written here recording
 * exactly what was generated, by whom, over which period and with which
 * filters. This is the single source of truth behind the report "Generation
 * history" view, and it captures the report snapshot metadata (period +
 * filters + generated-at/by) so a past view/download/send can always be
 * described — an audit trail for sensitive financial reports (Phase 34).
 *
 * The table is self-healing (created on first use) so the feature works even
 * before any SQL migration is run manually.
 */

export type ReportRunFormat = "PDF" | "Excel" | "CSV" | "Email" | "View"

export type ReportRunRow = {
  id: number
  report_key: string
  report_label: string
  format: ReportRunFormat
  period_label: string | null
  filters_text: string | null
  recipient: string | null
  status: string | null
  user_id: number | null
  user_name: string | null
  row_count: number | null
  generated_at: string
}

let schemaEnsured = false

export async function ensureReportRunSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS finance_report_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      report_key VARCHAR(80) NOT NULL,
      report_label VARCHAR(190) NOT NULL,
      format ENUM('PDF','Excel','CSV','Email','View') NOT NULL DEFAULT 'PDF',
      period_label VARCHAR(255) NULL,
      filters_text VARCHAR(500) NULL,
      recipient VARCHAR(320) NULL,
      status VARCHAR(30) NULL,
      user_id BIGINT UNSIGNED NULL,
      user_name VARCHAR(190) NULL,
      row_count INT UNSIGNED NULL,
      generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_report_runs_report (report_key),
      KEY idx_report_runs_format (format),
      KEY idx_report_runs_generated (generated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Widen the format ENUM on installs where the table predates the 'View'
  // audit event. Best-effort: a fresh table already has it, so ignore errors.
  try {
    await query(
      `ALTER TABLE finance_report_runs
         MODIFY COLUMN format ENUM('PDF','Excel','CSV','Email','View') NOT NULL DEFAULT 'PDF'`,
    )
  } catch (err) {
    console.log("[v0] report-runs ENUM upgrade skipped:", (err as Error).message)
  }
  schemaEnsured = true
}

export type LogReportRunInput = {
  reportKey: string
  reportLabel: string
  format: ReportRunFormat
  periodLabel?: string | null
  filtersText?: string | null
  recipient?: string | null
  status?: string | null
  userId?: number | null
  userName?: string | null
  rowCount?: number | null
}

/** Write one report-generation record. Best-effort: never throws to the caller. */
export async function logReportRun(input: LogReportRunInput): Promise<number | null> {
  try {
    await ensureReportRunSchema()
    const result = await query<any>(
      `INSERT INTO finance_report_runs
        (report_key, report_label, format, period_label, filters_text, recipient,
         status, user_id, user_name, row_count)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        input.reportKey.slice(0, 80),
        (input.reportLabel || input.reportKey).slice(0, 190),
        input.format,
        input.periodLabel ? input.periodLabel.slice(0, 255) : null,
        input.filtersText ? input.filtersText.slice(0, 500) : null,
        input.recipient ? input.recipient.slice(0, 320) : null,
        input.status ? input.status.slice(0, 30) : null,
        input.userId ?? null,
        input.userName ? input.userName.slice(0, 190) : null,
        input.rowCount ?? null,
      ],
    )
    return Number(result.insertId) || null
  } catch (err) {
    console.log("[v0] failed to log report run", (err as Error).message)
    return null
  }
}

export type ListReportRunsInput = {
  format?: ReportRunFormat | "all"
  reportKey?: string
  q?: string
  page?: number
  pageSize?: number
}

export type ListReportRunsResult = {
  runs: ReportRunRow[]
  total: number
  page: number
  pageSize: number
  summary: { total: number; downloads: number; emails: number; views: number }
}

export async function listReportRuns(input: ListReportRunsInput): Promise<ListReportRunsResult> {
  await ensureReportRunSchema()

  const where: string[] = []
  const args: any[] = []

  if (input.format && input.format !== "all") {
    where.push("format = ?")
    args.push(input.format)
  }
  if (input.reportKey) {
    where.push("report_key = ?")
    args.push(input.reportKey)
  }
  const q = (input.q || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(report_label LIKE ? OR user_name LIKE ? OR recipient LIKE ? OR period_label LIKE ?)")
    args.push(like, like, like, like)
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = Math.max(1, Number(input.page || 1))
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || 25)))
  const offset = (page - 1) * pageSize

  const [runs, totalRows, summaryRows] = await Promise.all([
    query<any[]>(
      `SELECT id, report_key, report_label, format, period_label, filters_text, recipient,
              status, user_id, user_name, row_count, generated_at
       FROM finance_report_runs ${clause}
       ORDER BY generated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
    query<any[]>(`SELECT COUNT(*) AS total FROM finance_report_runs ${clause}`, args),
    query<any[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(format <> 'Email') AS downloads,
         SUM(format = 'Email') AS emails
       FROM finance_report_runs`,
    ),
  ])

  const s = summaryRows[0] || {}
  return {
    runs: runs as ReportRunRow[],
    total: Number(totalRows[0]?.total || 0),
    page,
    pageSize,
    summary: {
      total: Number(s.total || 0),
      downloads: Number(s.downloads || 0),
      emails: Number(s.emails || 0),
    },
  }
}
