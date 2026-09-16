// Canonical recruitment pipeline stage system (Phase 11).
//
// This is the SINGLE source of truth for application/candidate stages across
// the whole Recruitment module. Both the operational pipeline
// (recruit_applications.stage) and the config-driven stage modules resolve to
// these keys, so there is exactly one stage vocabulary — no parallel systems.
//
// Client-safe: pure constants + helpers only, no server-only imports, so it can
// be used from client components (kanban, selects) and server code alike.

export type CanonicalStage =
  | "applied"
  | "screening"
  | "shortlisted"
  | "assessment"
  | "interview"
  | "selected"
  | "offer"
  | "offer_accepted"
  | "pre_joining"
  | "hired"
  | "rejected"
  | "hold"
  | "withdrawn"

export type StageDef = {
  key: CanonicalStage
  label: string
  tone: string
  /** Forward-progression order. Terminal stages are not part of the linear rank. */
  rank: number
  terminal?: boolean
}

// Progression stages carry an increasing rank; terminal stages sit outside the
// linear flow and are applied as override states.
export const CANONICAL_STAGES: StageDef[] = [
  { key: "applied", label: "Applied", rank: 0, tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30" },
  { key: "screening", label: "Screening", rank: 1, tone: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30" },
  { key: "shortlisted", label: "Shortlisted", rank: 2, tone: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30" },
  { key: "assessment", label: "Assessment", rank: 3, tone: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30" },
  { key: "interview", label: "Interview", rank: 4, tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  { key: "selected", label: "Selected", rank: 5, tone: "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30" },
  { key: "offer", label: "Offer", rank: 6, tone: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30" },
  { key: "offer_accepted", label: "Offer Accepted", rank: 7, tone: "bg-blue-600/15 text-blue-700 dark:text-blue-300 border-blue-600/30" },
  { key: "pre_joining", label: "Pre-Joining", rank: 8, tone: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30" },
  { key: "hired", label: "Hired", rank: 9, tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  { key: "rejected", label: "Rejected", rank: 100, terminal: true, tone: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30" },
  { key: "hold", label: "Hold", rank: 101, terminal: true, tone: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30" },
  { key: "withdrawn", label: "Withdrawn", rank: 102, terminal: true, tone: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30" },
]

const STAGE_BY_KEY = new Map<CanonicalStage, StageDef>(CANONICAL_STAGES.map((s) => [s.key, s]))

export const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  CANONICAL_STAGES.map((s) => [s.key, s.label]),
)

// Legacy / alternate spellings mapped to canonical keys so historical data and
// free-text results collapse into the one system.
const LEGACY_STAGE_MAP: Record<string, CanonicalStage> = {
  applied: "applied",
  new: "applied",
  sourced: "applied",
  phone_screen: "screening",
  phone_screening: "screening",
  screen: "screening",
  screening: "screening",
  shortlist: "shortlisted",
  shortlisted: "shortlisted",
  assessment: "assessment",
  test: "assessment",
  interview: "interview",
  interviewing: "interview",
  interviewed: "interview",
  selected: "selected",
  selection: "selected",
  offer: "offer",
  offered: "offer",
  offer_sent: "offer",
  offer_accepted: "offer_accepted",
  accepted: "offer_accepted",
  pre_joining: "pre_joining",
  "pre-joining": "pre_joining",
  prejoining: "pre_joining",
  onboarding: "pre_joining",
  hired: "hired",
  joined: "hired",
  joining: "hired",
  rejected: "rejected",
  reject: "rejected",
  declined: "rejected",
  hold: "hold",
  on_hold: "hold",
  "on-hold": "hold",
  onhold: "hold",
  withdrawn: "withdrawn",
  withdraw: "withdrawn",
  dropped: "withdrawn",
}

/** Coerce any raw stage string (legacy key, label, free text) into a canonical stage. */
export function normalizeStage(raw: unknown): CanonicalStage {
  if (!raw) return "applied"
  const v = String(raw).trim().toLowerCase()
  if (STAGE_BY_KEY.has(v as CanonicalStage)) return v as CanonicalStage
  if (LEGACY_STAGE_MAP[v]) return LEGACY_STAGE_MAP[v]
  // Match by label (e.g. "Offer Accepted").
  const byLabel = CANONICAL_STAGES.find((s) => s.label.toLowerCase() === v)
  if (byLabel) return byLabel.key
  const slug = v.replace(/[\s-]+/g, "_")
  if (STAGE_BY_KEY.has(slug as CanonicalStage)) return slug as CanonicalStage
  if (LEGACY_STAGE_MAP[slug]) return LEGACY_STAGE_MAP[slug]
  return "applied"
}

export function stageLabel(raw: unknown): string {
  return STAGE_BY_KEY.get(normalizeStage(raw))?.label ?? "Applied"
}

export function stageRank(stage: CanonicalStage): number {
  return STAGE_BY_KEY.get(stage)?.rank ?? 0
}

export function isTerminalStage(stage: CanonicalStage): boolean {
  return !!STAGE_BY_KEY.get(stage)?.terminal
}

// ---------------------------------------------------------------------------
// Stage-module result -> canonical stage mappers (write-back rules).
// Used so that saving a Screening / Assessment / Interview / Selection record
// advances the linked application through the one pipeline.
// ---------------------------------------------------------------------------
export function screeningResultToStage(result: unknown): CanonicalStage {
  const v = String(result ?? "").trim().toLowerCase()
  if (v === "shortlisted") return "shortlisted"
  if (v === "rejected") return "rejected"
  if (v === "on hold" || v === "hold") return "hold"
  // A screening record exists but no decision yet — at least reached screening.
  return "screening"
}

export function assessmentResultToStage(result: unknown): CanonicalStage {
  const v = String(result ?? "").trim().toLowerCase()
  if (v === "pass" || v === "passed") return "interview"
  if (v === "fail" || v === "failed") return "rejected"
  if (v === "on hold" || v === "hold") return "hold"
  return "assessment"
}

export function interviewResultToStage(result: unknown): CanonicalStage {
  const v = String(result ?? "").trim().toLowerCase()
  if (v === "selected") return "selected"
  if (v === "rejected") return "rejected"
  if (v === "on hold" || v === "hold") return "hold"
  return "interview"
}

/**
 * Interview Feedback (Phase 19) write-back. The panel's decision lives in
 * `final_result`; a still-`Pending` (or blank) evaluation must NOT move the
 * pipeline, so this returns null in that case and the caller skips the advance.
 */
export function feedbackResultToStage(record: Record<string, any>): CanonicalStage | null {
  const v = String(record?.final_result ?? "").trim().toLowerCase()
  if (v === "selected") return "selected"
  if (v === "rejected") return "rejected"
  if (v === "hold" || v === "on hold") return "hold"
  if (v === "next round") return "interview"
  return null
}

export function selectionResultToStage(record: Record<string, any>): CanonicalStage {
  const joining = String(record?.joining_status ?? "").trim().toLowerCase()
  const offer = String(record?.offer_status ?? "").trim().toLowerCase()
  if (joining === "joined") return "hired"
  if (joining === "dropped") return "withdrawn"
  if (offer === "accepted") return "offer_accepted"
  if (offer === "sent" || offer === "draft") return "offer"
  if (offer === "rejected") return "rejected"
  if (offer === "on hold" || offer === "hold") return "hold"
  return "selected"
}
