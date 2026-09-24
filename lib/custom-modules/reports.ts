/**
 * SPEC 96 — Custom Module Framework: pure report engine (Phase 3 & 4).
 * ---------------------------------------------------------------------------
 * Dependency-free, DB-free aggregation over a module's records. Kept separate
 * from service.ts (which fetches the rows) so the maths can be unit-tested
 * exhaustively without a live database. A metric is either a plain COUNT of
 * records or an aggregate (sum / avg / min / max) over one numeric field,
 * optionally grouped by another field's value.
 */
import {
  type ModuleDefinition,
  type ModuleReport,
  type ReportMetric,
  getFieldTypeDef,
} from "@/lib/custom-modules/model"
import { numericValueOf, toFieldDefinition } from "@/lib/custom-modules/model"

export type MetricResult = {
  key: string
  label: string
  op: string
  /** The overall value across every record. */
  total: number
  /** Per-group breakdown when the metric declares a groupBy, else empty. */
  groups: Array<{ group: string; value: number; count: number }>
}

export type ReportResult = {
  key: string
  label: string
  recordCount: number
  metrics: MetricResult[]
}

function numericFor(def: ModuleDefinition, fieldKey: string, values: Record<string, unknown>): number {
  const field = def.fields.find((f) => f.key === fieldKey)
  if (!field) return 0
  return numericValueOf(toFieldDefinition(def.slug, field), values[fieldKey])
}

function groupLabel(def: ModuleDefinition, fieldKey: string, values: Record<string, unknown>): string {
  const raw = values[fieldKey]
  if (raw == null || raw === "") return "—"
  if (Array.isArray(raw)) return raw.length ? raw.map(String).join(", ") : "—"
  if (typeof raw === "object") {
    const amount = (raw as any).amount
    if (amount != null) return String(amount)
    const id = (raw as any).id
    if (id != null) return String(id)
    return JSON.stringify(raw)
  }
  return String(raw)
}

function aggregate(op: string, nums: number[]): number {
  if (op === "count") return nums.length
  if (nums.length === 0) return 0
  switch (op) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0))
    case "avg":
      return round(nums.reduce((a, b) => a + b, 0) / nums.length)
    case "min":
      return round(Math.min(...nums))
    case "max":
      return round(Math.max(...nums))
    default:
      return 0
  }
}

function round(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0
}

function computeMetric(
  def: ModuleDefinition,
  metric: ReportMetric,
  rows: Array<Record<string, unknown>>,
): MetricResult {
  const isCount = metric.op === "count"
  const overallNums = isCount
    ? rows.map(() => 1)
    : rows.map((r) => numericFor(def, metric.field ?? "", r))
  const total = aggregate(metric.op, isCount ? overallNums : overallNums)

  const groups: MetricResult["groups"] = []
  if (metric.groupBy) {
    const buckets = new Map<string, number[]>()
    for (const r of rows) {
      const g = groupLabel(def, metric.groupBy, r)
      const arr = buckets.get(g) ?? []
      arr.push(isCount ? 1 : numericFor(def, metric.field ?? "", r))
      buckets.set(g, arr)
    }
    for (const [group, nums] of buckets) {
      groups.push({ group, value: aggregate(metric.op, nums), count: nums.length })
    }
    groups.sort((a, b) => b.value - a.value || a.group.localeCompare(b.group))
  }

  return { key: metric.key, label: metric.label, op: metric.op, total, groups }
}

/** Compute every metric of a report over the given record value-maps. */
export function computeReport(
  def: ModuleDefinition,
  report: ModuleReport,
  rows: Array<Record<string, unknown>>,
): ReportResult {
  return {
    key: report.key,
    label: report.label,
    recordCount: rows.length,
    metrics: report.metrics.map((m) => computeMetric(def, m, rows)),
  }
}

/** Guard used by the report builder UI: which fields can back a numeric metric. */
export function numericFieldKeys(def: ModuleDefinition): string[] {
  return def.fields.filter((f) => getFieldTypeDef(f.type)?.numeric).map((f) => f.key)
}
