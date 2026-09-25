/**
 * SPEC 20 (req #75) — AI Anomaly Detection: pure model / policy layer.
 * ---------------------------------------------------------------------------
 * NO DB, NO framework — just the maths, taxonomy and rules that both the server
 * service and the tests read from. Everything here is deterministic and pure so
 * the same input always yields the same alert (stable signatures → idempotent
 * dedup) and so the detectors can be unit-tested against synthetic baselines.
 *
 * Design guarantees encoded here:
 *   - Explainable-first: every finding carries the baseline stats, the observed
 *     value, the threshold it crossed and a robust z-score. Model scoring is an
 *     OPTIONAL enrichment layered on top (see scoring.ts), never a replacement.
 *   - Human review only: a detection is always born "open". No rule in this file
 *     ever transitions an alert to a resolved/confirmed state — that requires a
 *     human action routed through the service. See canTransitionStatus.
 *   - Robust to noise: baselines use the median + MAD (median absolute
 *     deviation) with sample-size and floor guards so a flat or low-volume
 *     series cannot manufacture false positives.
 */

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const ANOMALY_CATEGORIES = ["payment", "invoice", "access", "usage"] as const
export type AnomalyCategory = (typeof ANOMALY_CATEGORIES)[number]

/** Stable rule identifiers. `<category>.<rule>`. */
export const ANOMALY_SIGNALS = [
  "payment.amount_outlier",
  "payment.volume_spike",
  "payment.duplicate_amount",
  "invoice.amount_outlier",
  "invoice.volume_spike",
  "access.change_spike",
  "access.privilege_change",
  "usage.metric_spike",
] as const
export type AnomalySignal = (typeof ANOMALY_SIGNALS)[number]

export const SEVERITIES = ["low", "medium", "high", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]

export const ALERT_STATUSES = ["open", "investigating", "confirmed", "dismissed", "resolved"] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export const DETECTION_METHODS = ["rule", "model"] as const
export type DetectionMethod = (typeof DETECTION_METHODS)[number]

export function categoryForSignal(signal: AnomalySignal): AnomalyCategory {
  return signal.split(".")[0] as AnomalyCategory
}

// ---------------------------------------------------------------------------
// Statistics — small, dependency-free, all pure.
// ---------------------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Median absolute deviation — the robust analogue of stddev. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0
  const med = median(values)
  return median(values.map((v) => Math.abs(v - med)))
}

export type Baseline = {
  count: number
  mean: number
  median: number
  stddev: number
  mad: number
  min: number
  max: number
}

export function computeBaseline(values: number[]): Baseline {
  return {
    count: values.length,
    mean: round(mean(values), 4),
    median: round(median(values), 4),
    stddev: round(stddev(values), 4),
    mad: round(mad(values), 4),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  }
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp
  return Math.round((n + Number.EPSILON) * f) / f
}

/**
 * Robust deviation of `x` against a baseline sample. Prefers the median+MAD
 * estimator (1.4826 scales MAD to a stddev-equivalent); falls back to mean+
 * stddev only when MAD is zero (e.g. >50% identical values) and stddev is not.
 * Returns z=0 for a flat baseline so a constant series never fires.
 */
export function robustDeviation(
  sample: number[],
  x: number,
): { z: number; center: number; scale: number; method: "mad" | "stddev" | "flat" } {
  const med = median(sample)
  const scaledMad = 1.4826 * mad(sample)
  if (scaledMad > 1e-9) {
    return { z: (x - med) / scaledMad, center: med, scale: scaledMad, method: "mad" }
  }
  const sd = stddev(sample)
  if (sd > 1e-9) {
    return { z: (x - mean(sample)) / sd, center: mean(sample), scale: sd, method: "stddev" }
  }
  return { z: 0, center: med, scale: 0, method: "flat" }
}

// ---------------------------------------------------------------------------
// Scoring & severity
// ---------------------------------------------------------------------------

/**
 * Map an absolute robust z-score into a bounded risk score in [0,1] via a
 * logistic centered on the alert threshold (z0). At z=z0 the score is ~0.5; it
 * rises smoothly toward 1 for extreme deviations and never reaches exactly 1.
 */
export function scoreFromZ(absZ: number, z0 = DETECTOR_DEFAULTS.zThreshold, k = 0.6): number {
  const s = 1 / (1 + Math.exp(-(Math.abs(absZ) - z0) * k))
  return round(Math.min(0.999, Math.max(0, s)), 4)
}

export function severityFromScore(score: number): Severity {
  if (score >= 0.9) return "critical"
  if (score >= 0.75) return "high"
  if (score >= 0.6) return "medium"
  return "low"
}

// ---------------------------------------------------------------------------
// Detector tuning — bundled defaults, overridable per scan.
// ---------------------------------------------------------------------------

export const DETECTOR_DEFAULTS = {
  /** Minimum baseline observations before a series can raise an anomaly. */
  minSamples: 5,
  /** Robust z-score a point/period must exceed to be flagged. */
  zThreshold: 3.5,
  /**
   * Absolute floor on the deviation from center, so a tiny wobble on a small
   * baseline can never fire even if its z happens to be large. Applied in the
   * unit of the series (currency amount, event count, metric quantity).
   */
  minAbsoluteDeviation: 1,
  /** Duplicate rule: how many identical amounts within the window is suspicious. */
  duplicateMinCount: 3,
} as const

export type DetectorConfig = typeof DETECTOR_DEFAULTS

export function resolveDetectorConfig(overrides?: Partial<DetectorConfig>): DetectorConfig {
  return { ...DETECTOR_DEFAULTS, ...(overrides ?? {}) }
}

// ---------------------------------------------------------------------------
// Findings — the pure detector output, before persistence.
// ---------------------------------------------------------------------------

export type Finding = {
  signal: AnomalySignal
  category: AnomalyCategory
  /** The subject of the anomaly (e.g. "billing_payment", "meter", "actor"). */
  entityType: string
  entityId: string
  entityLabel: string | null
  observedValue: number
  score: number
  severity: Severity
  method: DetectionMethod
  title: string
  summary: string
  /** Explainable evidence: baseline stats, threshold, z, contributing rows. */
  evidence: Record<string, unknown>
  /** Business time the anomalous event occurred (for time-bucketed dedup). */
  occurredAt: string | null
}

// ---------------------------------------------------------------------------
// Dedup signature — stable identity of "the same anomaly".
// ---------------------------------------------------------------------------

/**
 * Deterministic signature so re-running a scan collapses onto the same alert
 * instead of creating duplicates. Bucketed by day of the occurrence so a spike
 * on a given day is one alert no matter how many times the scan runs, while the
 * same subject spiking on a different day is a distinct alert.
 */
export function deriveSignature(input: {
  tenantId: number
  signal: AnomalySignal
  entityType: string
  entityId: string
  occurredAt?: string | null
}): string {
  const bucket = dayBucket(input.occurredAt)
  const canonical = [input.tenantId, input.signal, input.entityType, input.entityId, bucket].join("|")
  return createHash("sha256").update(canonical).digest("hex").slice(0, 40)
}

export function dayBucket(occurredAt?: string | null): string {
  if (!occurredAt) return "nodate"
  const d = new Date(occurredAt)
  if (Number.isNaN(d.getTime())) return "nodate"
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Status machine — human review only.
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  open: ["investigating", "confirmed", "dismissed", "resolved"],
  investigating: ["confirmed", "dismissed", "resolved", "open"],
  confirmed: ["resolved", "dismissed", "investigating"],
  dismissed: ["open", "investigating"],
  resolved: ["open", "investigating"],
}

export function canTransitionStatus(from: AlertStatus, to: AlertStatus): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Statuses a human has actively triaged (used to decide re-open vs. bump). */
export const TERMINAL_STATUSES: AlertStatus[] = ["dismissed", "resolved"]

export function isTerminal(status: AlertStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function normalizeStatus(raw: string | null | undefined): AlertStatus {
  const s = (raw ?? "").trim().toLowerCase()
  return (ALERT_STATUSES as readonly string[]).includes(s) ? (s as AlertStatus) : "open"
}

export function normalizeSeverity(raw: string | null | undefined): Severity {
  const s = (raw ?? "").trim().toLowerCase()
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : "low"
}

// ---------------------------------------------------------------------------
// Resolution validation — a human decision, never automatic.
// ---------------------------------------------------------------------------

export type ReviewDecision = {
  status: AlertStatus
  note?: string | null
  ownerId?: number | null
}

export function validateReview(input: {
  from: AlertStatus
  to: AlertStatus
  note?: string | null
}): { ok: true } | { ok: false; error: string } {
  if (!(ALERT_STATUSES as readonly string[]).includes(input.to)) {
    return { ok: false, error: `Unknown status "${input.to}"` }
  }
  if (!canTransitionStatus(input.from, input.to)) {
    return { ok: false, error: `Cannot move an alert from "${input.from}" to "${input.to}"` }
  }
  // Terminal outcomes must be justified so the audit trail explains the human call.
  if ((input.to === "dismissed" || input.to === "resolved") && !String(input.note ?? "").trim()) {
    return { ok: false, error: `A note is required to ${input.to === "dismissed" ? "dismiss" : "resolve"} an alert` }
  }
  if (input.note != null && String(input.note).length > 1000) {
    return { ok: false, error: "Resolution note must be 1000 characters or fewer" }
  }
  return { ok: true }
}
