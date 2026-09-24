import "server-only"
/**
 * Zero-violation tenant-isolation audit + enforce rollout gate.
 * ---------------------------------------------------------------------------
 * The data-layer guard (lib/tenant-guard.ts) rolls out report-only -> enforce
 * exactly like CSP. Flipping to "enforce" is only safe once the schema and the
 * DATA are provably isolated: every tenant-owned table (lib/tenant-tables.ts)
 * must carry `tenant_id`, a covering index leading with `tenant_id`, and hold
 * NO rows that would leak — i.e. no NULL tenant stamps and no rows pointing at a
 * tenant that no longer exists.
 *
 * This module produces that evidence (auditTenantIsolation) and refuses the
 * switch until it is clean (assertReadyForEnforce). It is read-only: it never
 * mutates the schema (lib/tenant-ensure.ts self-heals) — it only INSPECTS, so
 * it is safe to run on demand from the platform console.
 */
import { query } from "@/lib/db"
import { TENANT_COLUMN, TENANT_OWNED_TABLES } from "@/lib/tenant-tables"
import { isolationMode, type IsolationMode } from "@/lib/tenant-guard"

export type TableAudit = {
  table: string
  /** Table is present in this database (skipped modules are absent, not broken). */
  exists: boolean
  hasTenantColumn: boolean
  /** An index whose FIRST column is tenant_id (single or composite). */
  hasTenantIndex: boolean
  /** A foreign key on tenant_id -> tenants(id). Recommended, not blocking. */
  hasForeignKey: boolean
  totalRows: number
  /** Rows with a NULL tenant stamp — unscoped, would leak under enforce. */
  nullTenantRows: number
  /** Rows pointing at a tenant id that does not exist in `tenants`. */
  orphanTenantRows: number
  /** Blocking issues that must be resolved before enforce is safe. */
  violations: string[]
  /** Non-blocking recommendations (e.g. a missing FK). */
  warnings: string[]
  clean: boolean
}

export type IsolationAuditReport = {
  generatedAt: string
  mode: IsolationMode
  tables: TableAudit[]
  totals: {
    tablesChecked: number
    tablesPresent: number
    missingColumn: number
    missingIndex: number
    missingForeignKey: number
    nullTenantRows: number
    orphanTenantRows: number
  }
  /** True when there are zero blocking violations across every present table. */
  clean: boolean
  /** True when the guard can be switched to enforce (== clean). */
  readyForEnforce: boolean
}

async function scalar(sql: string, params: any[] = []): Promise<number> {
  const rows = await query<{ n: number }[]>(sql, params)
  return Number(rows[0]?.n ?? 0)
}

async function tableExists(table: string): Promise<boolean> {
  return (
    (await scalar(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    )) > 0
  )
}

async function columnExists(table: string, column: string): Promise<boolean> {
  return (
    (await scalar(
      `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )) > 0
  )
}

/** An index that LEADS with tenant_id (seq_in_index = 1) — single or composite. */
async function leadingTenantIndexExists(table: string): Promise<boolean> {
  return (
    (await scalar(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND seq_in_index = 1`,
      [table, TENANT_COLUMN],
    )) > 0
  )
}

async function tenantForeignKeyExists(table: string): Promise<boolean> {
  return (
    (await scalar(
      `SELECT COUNT(*) AS n FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND referenced_table_name = 'tenants'`,
      [table, TENANT_COLUMN],
    )) > 0
  )
}

async function auditTable(table: string): Promise<TableAudit> {
  const base: TableAudit = {
    table,
    exists: false,
    hasTenantColumn: false,
    hasTenantIndex: false,
    hasForeignKey: false,
    totalRows: 0,
    nullTenantRows: 0,
    orphanTenantRows: 0,
    violations: [],
    warnings: [],
    clean: true,
  }

  if (!(await tableExists(table))) return base
  base.exists = true

  base.hasTenantColumn = await columnExists(table, TENANT_COLUMN)
  if (!base.hasTenantColumn) {
    base.violations.push("missing tenant_id column")
    base.clean = false
    return base // no point counting rows on a column that does not exist
  }

  base.hasTenantIndex = await leadingTenantIndexExists(table)
  if (!base.hasTenantIndex) base.violations.push("no index leading with tenant_id")

  base.hasForeignKey = await tenantForeignKeyExists(table)
  if (!base.hasForeignKey) base.warnings.push("no foreign key on tenant_id -> tenants(id)")

  base.totalRows = await scalar(`SELECT COUNT(*) AS n FROM \`${table}\``)
  base.nullTenantRows = await scalar(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${TENANT_COLUMN}\` IS NULL`,
  )
  base.orphanTenantRows = await scalar(
    `SELECT COUNT(*) AS n FROM \`${table}\` t
       LEFT JOIN \`tenants\` ten ON ten.id = t.\`${TENANT_COLUMN}\`
      WHERE t.\`${TENANT_COLUMN}\` IS NOT NULL AND ten.id IS NULL`,
  )

  if (base.nullTenantRows > 0) base.violations.push(`${base.nullTenantRows} row(s) with NULL tenant_id`)
  if (base.orphanTenantRows > 0)
    base.violations.push(`${base.orphanTenantRows} row(s) referencing a non-existent tenant`)

  base.clean = base.hasTenantColumn && base.hasTenantIndex && base.nullTenantRows === 0 && base.orphanTenantRows === 0
  return base
}

/**
 * Inspect every tenant-owned table and summarize whether the data is provably
 * isolated. Read-only. Tables absent from this database are reported as present:
 * false and never block the switch.
 */
export async function auditTenantIsolation(): Promise<IsolationAuditReport> {
  const tables: TableAudit[] = []
  for (const t of TENANT_OWNED_TABLES) {
    try {
      tables.push(await auditTable(t))
    } catch (err) {
      // A failed probe is itself a blocking unknown — surface it rather than
      // silently passing the audit.
      tables.push({
        table: t,
        exists: true,
        hasTenantColumn: false,
        hasTenantIndex: false,
        hasForeignKey: false,
        totalRows: 0,
        nullTenantRows: 0,
        orphanTenantRows: 0,
        violations: [`audit probe failed: ${(err as Error)?.message ?? "unknown error"}`],
        warnings: [],
        clean: false,
      })
    }
  }

  const present = tables.filter((t) => t.exists)
  const totals = {
    tablesChecked: tables.length,
    tablesPresent: present.length,
    missingColumn: present.filter((t) => !t.hasTenantColumn).length,
    missingIndex: present.filter((t) => t.hasTenantColumn && !t.hasTenantIndex).length,
    missingForeignKey: present.filter((t) => t.hasTenantColumn && !t.hasForeignKey).length,
    nullTenantRows: present.reduce((s, t) => s + t.nullTenantRows, 0),
    orphanTenantRows: present.reduce((s, t) => s + t.orphanTenantRows, 0),
  }
  const clean = tables.every((t) => t.clean)

  return {
    generatedAt: new Date().toISOString(),
    mode: isolationMode(),
    tables,
    totals,
    clean,
    readyForEnforce: clean,
  }
}

/** Thrown when a switch to enforce is attempted while the audit is not clean. */
export class IsolationNotReadyError extends Error {
  report: IsolationAuditReport
  constructor(report: IsolationAuditReport) {
    const offenders = report.tables.filter((t) => !t.clean).map((t) => t.table)
    super(
      `Tenant isolation is not ready for enforce: ${offenders.length} table(s) have blocking violations [${offenders.join(", ")}]. Resolve them (backfill NULL/orphan rows, add missing columns/indexes) before enforcing.`,
    )
    this.name = "IsolationNotReadyError"
    this.report = report
  }
}

/**
 * Gate for the rollout switch: run the audit and throw IsolationNotReadyError
 * unless it is clean. Returns the (clean) report so callers can log/audit it.
 */
export async function assertReadyForEnforce(): Promise<IsolationAuditReport> {
  const report = await auditTenantIsolation()
  if (!report.readyForEnforce) throw new IsolationNotReadyError(report)
  return report
}
