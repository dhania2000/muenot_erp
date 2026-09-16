import "server-only"
import { query } from "@/lib/db"

/**
 * Phase 96 — Configurable Recruitment workflow settings (single source of truth).
 *
 * Every configurable workflow day/threshold lives in the `recruitment_settings`
 * table (setting_name / setting_value) and is read through THIS module — the
 * stale-detection sweep, the offer/joining sweep and the follow-on task
 * automation all delegate here instead of each re-implementing their own reader
 * with their own hard-coded numbers. That gives one canonical registry, one
 * cached read, and a single place the Recruitment Settings UI seeds and edits.
 *
 * Reads degrade gracefully: a not-yet-migrated database (or a missing row)
 * simply falls back to the registry default, never throwing.
 */

export type SettingKind = "int" | "csv" | "bool"

export type RecruitmentSettingDef = {
  /** Canonical key stored in `setting_name` and read by every consumer. */
  key: string
  category: string
  label: string
  description: string
  /** String default written to `setting_value` when seeded, and used when unset. */
  default: string
  kind: SettingKind
}

/**
 * The canonical set of Recruitment settings. Seeded into `recruitment_settings`
 * so an administrator sees and can edit every knob from the Recruitment
 * Settings module. Defaults intentionally match the behaviour that was
 * previously hard-coded so existing installs behave identically until an
 * administrator changes a value.
 */
export const RECRUITMENT_SETTING_DEFS: RecruitmentSettingDef[] = [
  // --- SLA & reminders (Phase 96) ------------------------------------------
  {
    key: "feedback_sla_days",
    category: "SLA & Reminders",
    label: "Interview feedback SLA (days)",
    description: "Days after an interview by which panel feedback is due. Drives the auto-created 'Submit interview feedback' task.",
    default: "1",
    kind: "int",
  },
  {
    key: "followup_interval_days",
    category: "SLA & Reminders",
    label: "Candidate follow-up interval (days)",
    description: "Default gap between candidate follow-ups when a specific next date is not set.",
    default: "3",
    kind: "int",
  },
  {
    key: "offer_followup_days",
    category: "SLA & Reminders",
    label: "Offer acceptance follow-up (days)",
    description: "Days after an offer/selection to follow up on acceptance. Drives the auto-created 'Follow up on offer acceptance' task.",
    default: "3",
    kind: "int",
  },
  {
    key: "joining_confirm_lead_days",
    category: "SLA & Reminders",
    label: "Joining confirmation lead (days)",
    description: "Days before the expected joining date to confirm the candidate will join. Drives the auto-created 'Confirm joining' task.",
    default: "3",
    kind: "int",
  },
  {
    key: "bgv_sla_days",
    category: "SLA & Reminders",
    label: "Background verification SLA (days)",
    description: "Days to complete background verification once initiated. Drives the auto-created BGV task.",
    default: "7",
    kind: "int",
  },
  {
    key: "reference_sla_days",
    category: "SLA & Reminders",
    label: "Reference check SLA (days)",
    description: "Days to complete a reference check once started. Drives the auto-created reference task.",
    default: "5",
    kind: "int",
  },
  {
    key: "offer_expiry_reminder_days",
    category: "SLA & Reminders",
    label: "Offer expiry reminder tiers",
    description: "Comma-separated days before an offer's expiry date to remind the recruiter (e.g. 3,1).",
    default: "3,1",
    kind: "csv",
  },
  {
    key: "joining_reminder_days",
    category: "SLA & Reminders",
    label: "Joining reminder tiers",
    description: "Comma-separated days before an accepted offer's joining date to remind the recruiter (e.g. 7,3,1).",
    default: "7,3,1",
    kind: "csv",
  },
  // --- Stale detection (Phase 66-68) ---------------------------------------
  {
    key: "stale_application_days",
    category: "Stale Detection",
    label: "Application stale days",
    description: "Flag an application stuck in the same non-terminal stage for longer than this many days.",
    default: "7",
    kind: "int",
  },
  {
    key: "stale_requisition_grace_days",
    category: "Stale Detection",
    label: "Requisition stale days (grace)",
    description: "Grace days after a requisition's target date before an unfilled requisition is flagged as overdue.",
    default: "0",
    kind: "int",
  },
  {
    key: "stale_job_days",
    category: "Stale Detection",
    label: "Job stale days",
    description: "Flag an open job with no application activity for longer than this many days.",
    default: "14",
    kind: "int",
  },
  // --- Workflow rules -------------------------------------------------------
  {
    key: "offer_auto_expire",
    category: "Workflow Rules",
    label: "Auto-expire lapsed offers",
    description: "When enabled, offers past their expiry date are automatically marked expired (accepted offers are never touched).",
    default: "NO",
    kind: "bool",
  },
]

const DEF_BY_KEY = new Map(RECRUITMENT_SETTING_DEFS.map((d) => [d.key, d]))

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type SettingsMap = Map<string, string>

// Short-lived process cache: settings change rarely and are read on hot paths
// (every stage save, every cron sweep). A 15s TTL keeps edits near-live without
// hammering the database.
declare global {
  // eslint-disable-next-line no-var
  var __recruitSettingsCache: { at: number; map: SettingsMap } | undefined
}
const TTL_MS = 15_000

async function readRaw(): Promise<SettingsMap> {
  const map = new Map<string, string>()
  try {
    const rows = (await query(
      `SELECT LOWER(setting_name) AS name, setting_value AS value
         FROM recruitment_settings
        WHERE setting_name IS NOT NULL
          AND (active IS NULL OR UPPER(active) <> 'NO')`,
    )) as any[]
    for (const r of rows) {
      const name = String(r.name ?? "").trim()
      if (name && !map.has(name)) map.set(name, String(r.value ?? "").trim())
    }
  } catch {
    // Table not migrated yet — registry defaults apply.
  }
  return map
}

/** Cached raw settings map (canonical key -> stored string value). */
export async function getRecruitmentSettingsMap(): Promise<SettingsMap> {
  const cache = globalThis.__recruitSettingsCache
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.map
  const map = await readRaw()
  globalThis.__recruitSettingsCache = { at: now, map }
  return map
}

/** Invalidate the settings cache — call after a settings write for read-your-writes. */
export function invalidateRecruitmentSettingsCache(): void {
  globalThis.__recruitSettingsCache = undefined
}

function resolvedRaw(map: SettingsMap, key: string): string {
  const v = map.get(key)
  if (v !== undefined && v !== "") return v
  return DEF_BY_KEY.get(key)?.default ?? ""
}

/** Parse a positive integer day-count, falling back to the registry default. */
function readIntDays(map: SettingsMap, key: string, min = 0): number {
  const raw = resolvedRaw(map, key)
  const n = Number(raw)
  if (Number.isFinite(n) && n >= min) return Math.round(n)
  const def = Number(DEF_BY_KEY.get(key)?.default ?? 0)
  return Number.isFinite(def) ? Math.round(def) : 0
}

/** Parse a comma-separated day list ("7,3,1") into a sorted, de-duplicated, positive-int array. */
export function parseDayTiers(raw: string | undefined, fallback: string): number[] {
  const source = String(raw ?? "").trim() || fallback
  const tiers = new Set<number>()
  for (const part of source.split(/[,\s]+/)) {
    const n = Number(part)
    if (Number.isFinite(n) && n >= 0) tiers.add(Math.round(n))
  }
  return [...tiers].sort((a, b) => b - a)
}

function readCsvDays(map: SettingsMap, key: string): number[] {
  return parseDayTiers(map.get(key), DEF_BY_KEY.get(key)?.default ?? "")
}

function readBool(map: SettingsMap, key: string): boolean {
  const raw = resolvedRaw(map, key).toLowerCase()
  return ["yes", "true", "1", "on", "enabled"].includes(raw)
}

export type WorkflowDays = {
  feedbackSlaDays: number
  followupIntervalDays: number
  offerFollowupDays: number
  joiningConfirmLeadDays: number
  bgvSlaDays: number
  referenceSlaDays: number
  offerExpiryReminderDays: number[]
  joiningReminderDays: number[]
  staleApplicationDays: number
  staleRequisitionGraceDays: number
  staleJobDays: number
  offerAutoExpire: boolean
}

/** The fully-resolved, typed workflow settings used across the Recruitment module. */
export async function getWorkflowDays(): Promise<WorkflowDays> {
  const map = await getRecruitmentSettingsMap()
  return {
    feedbackSlaDays: readIntDays(map, "feedback_sla_days"),
    followupIntervalDays: readIntDays(map, "followup_interval_days", 1),
    offerFollowupDays: readIntDays(map, "offer_followup_days"),
    joiningConfirmLeadDays: readIntDays(map, "joining_confirm_lead_days"),
    bgvSlaDays: readIntDays(map, "bgv_sla_days"),
    referenceSlaDays: readIntDays(map, "reference_sla_days"),
    offerExpiryReminderDays: readCsvDays(map, "offer_expiry_reminder_days"),
    joiningReminderDays: readCsvDays(map, "joining_reminder_days"),
    staleApplicationDays: readIntDays(map, "stale_application_days", 1),
    staleRequisitionGraceDays: readIntDays(map, "stale_requisition_grace_days"),
    staleJobDays: readIntDays(map, "stale_job_days", 1),
    offerAutoExpire: readBool(map, "offer_auto_expire"),
  }
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

let schemaEnsured = false
async function ensureSettingsTable(): Promise<void> {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruitment_settings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      setting_id VARCHAR(40) NOT NULL,
      setting_category VARCHAR(120) DEFAULT NULL,
      setting_name VARCHAR(190) DEFAULT NULL,
      setting_value VARCHAR(255) DEFAULT NULL,
      description TEXT,
      active VARCHAR(10) DEFAULT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_set_id (setting_id),
      KEY idx_set_category (setting_category),
      KEY idx_set_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})
  schemaEnsured = true
}

let seeded = false
/**
 * Idempotently seed the canonical settings so they appear in the Recruitment
 * Settings module. A row is only inserted when NO row with that `setting_name`
 * already exists, so a value an administrator has edited is never overwritten
 * and re-running is a no-op. Best-effort: a seeding failure is logged, never
 * thrown, so it can never block a page load.
 */
export async function seedRecruitmentSettings(userId: number | null = null): Promise<void> {
  if (seeded) return
  try {
    await ensureSettingsTable()
    for (const d of RECRUITMENT_SETTING_DEFS) {
      await query(
        `INSERT INTO recruitment_settings
           (setting_id, setting_category, setting_name, setting_value, description, active, created_by)
         SELECT ?, ?, ?, ?, ?, 'YES', ?
           FROM dual
          WHERE NOT EXISTS (SELECT 1 FROM recruitment_settings WHERE setting_name = ?)`,
        [`RSET_${d.key}`, d.category, d.key, d.default, d.description, userId, d.key],
      ).catch((e) => {
        console.error(`[recruit-settings] seed row ${d.key} failed`, e)
      })
    }
    seeded = true
    invalidateRecruitmentSettingsCache()
  } catch (e) {
    console.error("[recruit-settings] seed failed", e)
  }
}
