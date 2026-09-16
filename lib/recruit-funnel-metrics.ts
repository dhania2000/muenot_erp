import { query } from "@/lib/db"
import { normalizeStage, stageRank, isTerminalStage } from "@/lib/recruitment-stages"

/**
 * PHASE 33/34: derive Recruitment Source and Campaign funnels from the ONE
 * canonical application pipeline (recruit_applications) instead of trusting
 * hand-entered counts. Every application already stores its `source` and
 * `campaign`, and its `stage` resolves to the single canonical vocabulary, so
 * the funnel for any source/campaign is just an aggregation over the real rows.
 *
 * This keeps Sources and Campaigns as true rollups of the pipeline: adding an
 * application, or advancing a candidate's stage, updates their numbers with no
 * duplicate data entry.
 */

export type Funnel = {
  applications: number
  shortlisted: number
  interviewed: number
  selected: number
  joined: number
}

function emptyFunnel(): Funnel {
  return { applications: 0, shortlisted: 0, interviewed: 0, selected: 0, joined: 0 }
}

/**
 * Count one application into a funnel. We only know each application's CURRENT
 * canonical stage, so progression buckets count anyone whose current stage is
 * at/beyond that step. Terminal states (rejected/hold/withdrawn) don't record
 * how far the candidate previously got, so they count as an application only —
 * never inflating the shortlisted/interviewed/selected steps. "hired" is a
 * progression stage (rank 9), so a joined candidate rolls up through every step.
 */
function bucket(f: Funnel, rawStage: unknown) {
  const stage = normalizeStage(rawStage)
  f.applications++
  if (stage === "hired") f.joined++
  if (isTerminalStage(stage)) return
  const r = stageRank(stage)
  if (r >= 2) f.shortlisted++ // shortlisted or beyond
  if (r >= 4) f.interviewed++ // interview or beyond
  if (r >= 5) f.selected++ // selected/offer or beyond
}

/** Aggregate the pipeline into a funnel per distinct value of `field`, keyed lowercased. */
async function computeFunnelsByKey(field: "campaign" | "source"): Promise<Map<string, Funnel>> {
  const map = new Map<string, Funnel>()
  const rows = (await query(
    `SELECT ${field} AS k, stage FROM recruit_applications WHERE ${field} IS NOT NULL AND ${field} <> ''`,
  )) as any[]
  for (const row of rows) {
    const key = String(row.k ?? "").trim().toLowerCase()
    if (!key) continue
    let f = map.get(key)
    if (!f) {
      f = emptyFunnel()
      map.set(key, f)
    }
    bucket(f, row.stage)
  }
  return map
}

/** First funnel matching any of the candidate keys (id or name), lowercased. */
function matchFunnel(map: Map<string, Funnel>, keys: (string | null | undefined)[]): Funnel {
  for (const k of keys) {
    if (!k) continue
    const f = map.get(String(k).trim().toLowerCase())
    if (f) return f
  }
  return emptyFunnel()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Overlay pipeline-derived funnel numbers onto the Campaign / Source module rows
 * and their KPI summary, in place. Called from the config CRUD GET so the module
 * always reflects the live pipeline. Applications link to a campaign by name or
 * id (recruit_applications.campaign) and to a source likewise
 * (recruit_applications.source).
 */
export async function applyFunnelMetrics(
  moduleKey: string,
  rows: any[],
  summary: Record<string, any>,
): Promise<void> {
  if (moduleKey === "recruitment-campaigns") {
    const funnels = await computeFunnelsByKey("campaign")
    let apps = 0
    let shortlisted = 0
    let selected = 0
    let joined = 0
    for (const r of rows) {
      const f = matchFunnel(funnels, [r.campaign_name, r.campaign_id])
      r.applications_received = f.applications
      r.shortlisted = f.shortlisted
      r.interviewed = f.interviewed
      r.selected = f.selected
      r.joined = f.joined
      apps += f.applications
      shortlisted += f.shortlisted
      selected += f.selected
      joined += f.joined
    }
    summary.total_applications = apps
    summary.total_shortlisted = shortlisted
    summary.total_selected = selected
    summary.total_joined = joined
    return
  }

  if (moduleKey === "recruitment-sources") {
    const funnels = await computeFunnelsByKey("source")
    let apps = 0
    let joined = 0
    for (const r of rows) {
      const f = matchFunnel(funnels, [r.source_name, r.source_id])
      r.applications = f.applications
      r.shortlisted = f.shortlisted
      r.selected = f.selected
      r.joined = f.joined
      r.conversion_rate = f.applications > 0 ? round2((f.joined / f.applications) * 100) : 0
      apps += f.applications
      joined += f.joined
    }
    summary.total_applications = apps
    summary.total_joined = joined
  }
}
