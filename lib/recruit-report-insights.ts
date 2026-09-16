import "server-only"
import { query } from "@/lib/db"
import { normalizeStage, stageRank, isTerminalStage } from "@/lib/recruitment-stages"

/**
 * PHASE 75/76/77 — Recruit Report insights.
 *
 * Every number here is derived from the ONE canonical pipeline
 * (recruit_applications, normalised to canonical stages) and the real stage
 * tables (recruit_offers, recruit_jobs, recruitment_requisitions) — never from
 * hand-entered KPI fields. Advancing a candidate or accepting an offer updates
 * these automatically. KPIs that depend on elapsed time are computed from the
 * actual `applied_at` / `updated_at` / `created_at` timestamps.
 */

async function safeQuery<T = any[]>(sql: string, args: any[] = []): Promise<T> {
  try {
    return (await query<T>(sql, args)) as T
  } catch {
    return [] as unknown as T
  }
}

async function safeScalar(sql: string, args: any[] = []): Promise<number | null> {
  try {
    const [row] = await query<any[]>(sql, args)
    const v = row?.v
    return v === null || v === undefined ? null : Number(v)
  } catch {
    return null
  }
}

// One roll-up of counts for a segment of applications, using each application's
// CURRENT canonical stage. Terminal states (rejected/hold/withdrawn) count only
// as an application — we don't know how far they previously got.
type Perf = {
  key: string
  applications: number
  screened: number
  shortlisted: number
  interviewed: number
  selected: number
  offers: number
  joined: number
  conversion: number // joined / applications, %
}

function blankPerf(key: string): Perf {
  return { key, applications: 0, screened: 0, shortlisted: 0, interviewed: 0, selected: 0, offers: 0, joined: 0, conversion: 0 }
}

function bucket(p: Perf, rawStage: unknown) {
  const stage = normalizeStage(rawStage)
  p.applications++
  if (stage === "hired") p.joined++
  if (isTerminalStage(stage)) return
  const r = stageRank(stage)
  if (r >= 1) p.screened++
  if (r >= 2) p.shortlisted++
  if (r >= 4) p.interviewed++
  if (r >= 5) p.selected++
  if (r >= 6) p.offers++
}

function finalize(map: Map<string, Perf>): Perf[] {
  const out = [...map.values()]
  for (const p of out) p.conversion = p.applications > 0 ? Math.round((p.joined / p.applications) * 1000) / 10 : 0
  out.sort((a, b) => b.applications - a.applications)
  return out
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0
}

export type RecruitmentInsights = {
  kpis: {
    timeToHire: number | null
    timeToFill: number | null
    offerAcceptanceRate: number
    joiningRatio: number
    screeningConversion: number
    interviewConversion: number
    sourceConversion: number
    requisitionAging: number | null
    jobAging: number | null
    applicationAging: number | null
  }
  totals: Perf
  analytics: {
    source: Perf[]
    campaign: Perf[]
    recruiter: Perf[]
  }
}

export async function getRecruitmentInsights(): Promise<RecruitmentInsights> {
  // Single scan of the canonical pipeline for every stage/attribution roll-up.
  const apps = await safeQuery<any[]>(
    "SELECT source, campaign, recruiter, stage FROM recruit_applications LIMIT 50000",
  )

  const totals = blankPerf("__total__")
  const bySource = new Map<string, Perf>()
  const byCampaign = new Map<string, Perf>()
  const byRecruiter = new Map<string, Perf>()

  const into = (map: Map<string, Perf>, rawKey: unknown, stage: unknown) => {
    const key = String(rawKey ?? "").trim() || "—"
    let p = map.get(key)
    if (!p) { p = blankPerf(key); map.set(key, p) }
    bucket(p, stage)
  }

  for (const a of apps) {
    bucket(totals, a.stage)
    into(bySource, a.source, a.stage)
    into(byCampaign, a.campaign, a.stage)
    into(byRecruiter, a.recruiter, a.stage)
  }

  // Offer-level rates from the real offers table.
  const [offerAgg] = await safeQuery<any[]>(
    "SELECT COUNT(*) AS total, SUM(status='accepted') AS accepted FROM recruit_offers",
  )
  const offersTotal = Number(offerAgg?.total || 0)
  const offersAccepted = Number(offerAgg?.accepted || 0)

  // Time-based KPIs from actual timestamps (best-effort; null when no data).
  const timeToHire = await safeScalar(
    "SELECT AVG(DATEDIFF(updated_at, applied_at)) AS v FROM recruit_applications WHERE LOWER(COALESCE(stage,'')) IN ('hired','joined') AND updated_at >= applied_at",
  )
  const timeToFill = await safeScalar(
    "SELECT AVG(DATEDIFF(updated_at, requisition_date)) AS v FROM recruitment_requisitions WHERE LOWER(COALESCE(status,'')) IN ('filled','closed','completed') AND requisition_date IS NOT NULL AND updated_at >= requisition_date",
  )
  const applicationAging = await safeScalar(
    "SELECT AVG(DATEDIFF(NOW(), applied_at)) AS v FROM recruit_applications WHERE LOWER(COALESCE(stage,'')) NOT IN ('hired','joined','rejected','reject','declined','withdrawn','withdraw','dropped')",
  )
  const jobAging = await safeScalar(
    "SELECT AVG(DATEDIFF(NOW(), created_at)) AS v FROM recruit_jobs WHERE LOWER(COALESCE(status,''))='open'",
  )
  const requisitionAging = await safeScalar(
    "SELECT AVG(DATEDIFF(NOW(), requisition_date)) AS v FROM recruitment_requisitions WHERE LOWER(COALESCE(status,'')) NOT IN ('closed','filled','cancelled','rejected','completed','on hold') AND requisition_date IS NOT NULL",
  )

  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

  return {
    kpis: {
      timeToHire: round1(timeToHire),
      timeToFill: round1(timeToFill),
      offerAcceptanceRate: pct(offersAccepted, offersTotal),
      joiningRatio: pct(totals.joined, offersAccepted),
      screeningConversion: pct(totals.shortlisted, totals.screened),
      interviewConversion: pct(totals.selected, totals.interviewed),
      sourceConversion: pct(totals.joined, totals.applications),
      requisitionAging: round1(requisitionAging),
      jobAging: round1(jobAging),
      applicationAging: round1(applicationAging),
    },
    totals,
    analytics: {
      source: finalize(bySource),
      campaign: finalize(byCampaign),
      recruiter: finalize(byRecruiter),
    },
  }
}
