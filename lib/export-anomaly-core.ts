/**
 * Export anomaly detection — pure, testable core (Spec25 · #216).
 * ---------------------------------------------------------------------------
 * Turns the facts of a completed data export into a decision about whether it
 * is BULK or UNUSUAL and therefore worth a security alert. Kept DB-free and
 * deterministic so thresholds are unit-testable; the store supplies the live
 * facts (row count, scope, recent export frequency) and raises the alert.
 *
 * Signals:
 *   - bulk       → the artifact row count crosses a large-volume threshold, or
 *                  the scope is the entire tenant (full-tenant export).
 *   - unusual    → an abnormal burst of exports by the same actor in a short
 *                  window (exfiltration-by-many-small-exports), OR an export to
 *                  an external/off-platform destination.
 *
 * Severity escalates when multiple signals combine.
 */

export type ExportDestinationKind = "download" | "scheduler" | "external"

export type ExportAnomalyInput = {
  rowCount: number
  isFullTenant: boolean
  /** Exports by the same actor within the recent window, INCLUDING this one. */
  recentExportCount: number
  destination: ExportDestinationKind
}

export type ExportAnomalyThresholds = {
  /** Row count at/above which a single export is considered bulk. */
  bulkRowCount: number
  /** Actor export count within the window at/above which it is a burst. */
  burstCount: number
}

export const DEFAULT_EXPORT_ANOMALY_THRESHOLDS: ExportAnomalyThresholds = {
  bulkRowCount: 5_000,
  burstCount: 5,
}

export type ExportAnomalySeverity = "info" | "warning" | "critical"

export type ExportAnomalyAssessment = {
  bulk: boolean
  unusual: boolean
  /** True when any signal fired and an alert should be raised. */
  alert: boolean
  severity: ExportAnomalySeverity
  reasons: string[]
}

/**
 * Assess an export against thresholds. Pure over its inputs.
 */
export function assessExport(
  input: ExportAnomalyInput,
  thresholds: ExportAnomalyThresholds = DEFAULT_EXPORT_ANOMALY_THRESHOLDS,
): ExportAnomalyAssessment {
  const reasons: string[] = []

  const bulkByRows = input.rowCount >= thresholds.bulkRowCount
  const bulkByScope = input.isFullTenant
  const bulk = bulkByRows || bulkByScope
  if (bulkByScope) reasons.push("full_tenant_scope")
  if (bulkByRows) reasons.push(`row_count>=${thresholds.bulkRowCount}`)

  const burst = input.recentExportCount >= thresholds.burstCount
  const external = input.destination === "external"
  const unusual = burst || external
  if (burst) reasons.push(`export_burst>=${thresholds.burstCount}`)
  if (external) reasons.push("external_destination")

  const alert = bulk || unusual
  // Two or more independent signals → critical; a single signal → warning.
  const signalCount = [bulkByRows, bulkByScope, burst, external].filter(Boolean).length
  const severity: ExportAnomalySeverity = !alert ? "info" : signalCount >= 2 ? "critical" : "warning"

  return { bulk, unusual, alert, severity, reasons }
}
