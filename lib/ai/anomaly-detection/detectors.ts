/**
 * SPEC 20 (req #75) — explainable rule detectors (pure).
 * ---------------------------------------------------------------------------
 * Each detector takes a plain, already-tenant-scoped observation set (built by
 * collectors.ts) and returns Findings. They contain NO IO and NO tenant logic,
 * so they are fully unit-testable against synthetic baselines: noisy series,
 * flat series and low-volume series must NOT fire (false-positive control),
 * while a genuine outlier must.
 */

import {
  categoryForSignal,
  computeBaseline,
  robustDeviation,
  scoreFromZ,
  severityFromScore,
  resolveDetectorConfig,
  round,
  type AnomalySignal,
  type DetectorConfig,
  type Finding,
} from "./model"

// ---------------------------------------------------------------------------
// Observation shapes
// ---------------------------------------------------------------------------

/** A single monetary record (a payment or an invoice). */
export type AmountObservation = {
  id: string
  amount: number
  label?: string | null
  occurredAt?: string | null
  party?: string | null
}

/** One time bucket (usually a day) with a numeric measure. */
export type SeriesPoint = {
  bucket: string // e.g. "2027-01-20"
  value: number
  label?: string | null
}

function makeFinding(input: {
  signal: AnomalySignal
  entityType: string
  entityId: string
  entityLabel: string | null
  observedValue: number
  z: number
  title: string
  summary: string
  evidence: Record<string, unknown>
  occurredAt: string | null
  config: DetectorConfig
}): Finding {
  const score = scoreFromZ(Math.abs(input.z), input.config.zThreshold)
  return {
    signal: input.signal,
    category: categoryForSignal(input.signal),
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel,
    observedValue: round(input.observedValue, 2),
    score,
    severity: severityFromScore(score),
    method: "rule",
    title: input.title,
    summary: input.summary,
    evidence: { ...input.evidence, robustZ: round(input.z, 3), scoreBasis: "robust-z" },
    occurredAt: input.occurredAt,
  }
}

// ---------------------------------------------------------------------------
// 1. Point outliers — a single amount that dwarfs the tenant's own history.
// ---------------------------------------------------------------------------

export function detectAmountOutliers(
  signal: Extract<AnomalySignal, "payment.amount_outlier" | "invoice.amount_outlier">,
  entityType: string,
  records: AmountObservation[],
  overrides?: Partial<DetectorConfig>,
): Finding[] {
  const config = resolveDetectorConfig(overrides)
  const amounts = records.map((r) => r.amount).filter((n) => Number.isFinite(n))
  if (amounts.length < config.minSamples) return []

  const baseline = computeBaseline(amounts)
  const noun = signal.startsWith("payment") ? "payment" : "invoice"
  const findings: Finding[] = []

  for (const rec of records) {
    if (!Number.isFinite(rec.amount)) continue
    // Compare each record against the baseline of the OTHER records so a single
    // huge value cannot inflate its own center/scale and hide itself.
    const others = amounts.filter((_, i) => amounts[i] !== rec.amount || i !== amounts.indexOf(rec.amount))
    const sample = others.length >= config.minSamples ? others : amounts
    const dev = robustDeviation(sample, rec.amount)
    const absDeviation = Math.abs(rec.amount - dev.center)
    if (dev.method === "flat") continue
    if (Math.abs(dev.z) < config.zThreshold) continue
    if (absDeviation < config.minAbsoluteDeviation) continue
    // Only unusually LARGE amounts are risk-relevant here.
    if (rec.amount <= dev.center) continue

    findings.push(
      makeFinding({
        signal,
        entityType,
        entityId: rec.id,
        entityLabel: rec.label ?? rec.party ?? null,
        observedValue: rec.amount,
        z: dev.z,
        title: `Unusual ${noun} amount: ${formatMoney(rec.amount)}`,
        summary: `A ${noun} of ${formatMoney(rec.amount)} is ${round(dev.z, 1)}× robust deviations above the typical ${formatMoney(dev.center)}.`,
        evidence: {
          rule: signal,
          observedAmount: round(rec.amount, 2),
          baselineCenter: round(dev.center, 2),
          baselineScale: round(dev.scale, 2),
          estimator: dev.method,
          threshold: config.zThreshold,
          baseline,
          party: rec.party ?? null,
        },
        occurredAt: rec.occurredAt ?? null,
        config,
      }),
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2. Volume / metric spikes — a time bucket far above the historical baseline.
// ---------------------------------------------------------------------------

export function detectSeriesSpike(
  signal: Extract<
    AnomalySignal,
    "payment.volume_spike" | "invoice.volume_spike" | "access.change_spike" | "usage.metric_spike"
  >,
  entityType: string,
  entityId: string,
  entityLabel: string | null,
  series: SeriesPoint[],
  overrides?: Partial<DetectorConfig>,
): Finding[] {
  const config = resolveDetectorConfig(overrides)
  if (series.length < config.minSamples + 1) return []

  // The most recent bucket is the candidate; the rest are the baseline.
  const sorted = [...series].sort((a, b) => a.bucket.localeCompare(b.bucket))
  const candidate = sorted[sorted.length - 1]
  const history = sorted.slice(0, -1).map((p) => p.value)
  if (history.length < config.minSamples) return []

  const baseline = computeBaseline(history)
  const dev = robustDeviation(history, candidate.value)
  const absDeviation = Math.abs(candidate.value - dev.center)
  if (dev.method === "flat") return []
  if (dev.z < config.zThreshold) return [] // only spikes UP matter
  if (absDeviation < config.minAbsoluteDeviation) return []

  const label = describeSpike(signal, candidate.value, dev.center)
  return [
    makeFinding({
      signal,
      entityType,
      entityId,
      entityLabel,
      observedValue: candidate.value,
      z: dev.z,
      title: label.title,
      summary: label.summary,
      evidence: {
        rule: signal,
        bucket: candidate.bucket,
        observedValue: round(candidate.value, 2),
        baselineCenter: round(dev.center, 2),
        baselineScale: round(dev.scale, 2),
        estimator: dev.method,
        threshold: config.zThreshold,
        baseline,
        historyBuckets: sorted.length - 1,
      },
      occurredAt: `${candidate.bucket}T00:00:00.000Z`,
      config,
    }),
  ]
}

// ---------------------------------------------------------------------------
// 3. Duplicate amounts — the same amount repeated suspiciously often (a classic
//    double-pay / split signal). Explainable and cheap; no statistics needed.
// ---------------------------------------------------------------------------

export function detectDuplicateAmounts(
  entityType: string,
  records: AmountObservation[],
  overrides?: Partial<DetectorConfig>,
): Finding[] {
  const config = resolveDetectorConfig(overrides)
  const groups = new Map<string, AmountObservation[]>()
  for (const rec of records) {
    if (!Number.isFinite(rec.amount) || rec.amount <= 0) continue
    const key = `${round(rec.amount, 2)}|${(rec.party ?? "").trim().toLowerCase()}`
    const arr = groups.get(key) ?? []
    arr.push(rec)
    groups.set(key, arr)
  }

  const findings: Finding[] = []
  for (const [key, arr] of groups) {
    if (arr.length < config.duplicateMinCount) continue
    const amount = arr[0].amount
    const party = arr[0].party ?? null
    // Score scales with how far past the threshold the repetition count is.
    const excess = arr.length - config.duplicateMinCount
    const score = Math.min(0.95, 0.6 + excess * 0.1)
    findings.push({
      signal: "payment.duplicate_amount",
      category: "payment",
      entityType,
      entityId: `dup:${key}`,
      entityLabel: party,
      observedValue: amount,
      score: round(score, 4),
      severity: severityFromScore(score),
      method: "rule",
      title: `Repeated identical amount ${formatMoney(amount)} ×${arr.length}`,
      summary: `${arr.length} records share the exact amount ${formatMoney(amount)}${party ? ` for "${party}"` : ""}, which can indicate a duplicate or split payment.`,
      evidence: {
        rule: "payment.duplicate_amount",
        amount: round(amount, 2),
        party,
        count: arr.length,
        threshold: config.duplicateMinCount,
        recordIds: arr.map((r) => r.id).slice(0, 50),
      },
      occurredAt: latestDate(arr.map((r) => r.occurredAt ?? null)),
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeSpike(signal: AnomalySignal, observed: number, center: number): { title: string; summary: string } {
  const ratio = center > 0 ? round(observed / center, 1) : null
  const times = ratio ? `${ratio}× the usual` : "well above the usual"
  switch (signal) {
    case "payment.volume_spike":
      return {
        title: `Payment volume spike (${Math.round(observed)} in a day)`,
        summary: `Daily payment count reached ${Math.round(observed)}, ${times} baseline of ${Math.round(center)}.`,
      }
    case "invoice.volume_spike":
      return {
        title: `Invoice volume spike (${Math.round(observed)} in a day)`,
        summary: `Daily invoice count reached ${Math.round(observed)}, ${times} baseline of ${Math.round(center)}.`,
      }
    case "access.change_spike":
      return {
        title: `Access-change spike (${Math.round(observed)} in a day)`,
        summary: `${Math.round(observed)} access/permission changes occurred, ${times} baseline of ${Math.round(center)}.`,
      }
    case "usage.metric_spike":
      return {
        title: `Usage spike (${round(observed, 2)} in a day)`,
        summary: `Metered usage reached ${round(observed, 2)}, ${times} baseline of ${round(center, 2)}.`,
      }
    default:
      return { title: "Anomalous spike", summary: `Observed ${observed}, baseline ${center}.` }
  }
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(round(n, 2))
}

function latestDate(dates: (string | null)[]): string | null {
  const valid = dates.filter((d): d is string => !!d && !Number.isNaN(new Date(d).getTime()))
  if (valid.length === 0) return null
  return valid.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
}
