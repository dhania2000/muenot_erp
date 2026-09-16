import "server-only"
import { query } from "@/lib/db"
import { ensureLeadLifecycleSchema, notify } from "@/lib/sales/lead-lifecycle"
import { syncOfferStatus } from "@/lib/recruit-status-sync"

/**
 * Phases 69 & 70 — Offer-expiry and Joining reminder automation.
 *
 * Runs on the existing authenticated recruitment sweep
 * (/api/cron/recruit-reminders, CRON_SECRET — Phases 63/64) and drives two
 * date-based workflows off the offer's OWN dates, not off manually-created
 * tasks:
 *
 *   * Phase 69 — Offer Expiry: for every live (non-terminal) offer we send a
 *     reminder a configurable number of days BEFORE `expiry_date`
 *     (`offer_expiry_reminder_days`, default "3,1"). AFTER `expiry_date` we
 *     mark the offer `expired` ONLY when the configured business rule allows it
 *     (`offer_auto_expire`, default off) — and NEVER touch an accepted offer.
 *     When auto-expire is off we still notify the owner once that the offer has
 *     lapsed so a human can decide.
 *
 *   * Phase 70 — Joining: for every accepted offer with a future `joining_date`
 *     we send tiered reminders a configurable number of days before joining
 *     (`joining_reminder_days`, default "7,3,1").
 *
 * Idempotency (Phase 65): every notification / transition is claimed against
 * the shared `recruitment_reminder_log` UNIQUE dedupe key. The key embeds the
 * concrete date (and tier) so each tier fires at most once and re-running the
 * cron never produces a duplicate. Everything is best-effort: a bad row or a
 * not-yet-migrated table is logged/ignored, never thrown.
 */

/** Offer statuses that are terminal / not eligible for expiry handling. */
const TERMINAL_OFFER_STATUSES = ["accepted", "declined", "rejected", "withdrawn", "joined", "expired", "cancelled"]

const DEFAULTS = {
  offer_expiry_reminder_days: "3,1",
  joining_reminder_days: "7,3,1",
  offer_auto_expire: false,
} as const

async function safeRows(sql: string, params: any[] = []): Promise<any[]> {
  try {
    return (await query(sql, params)) as any[]
  } catch {
    // Table not migrated yet on a fresh install — nothing to scan.
    return []
  }
}

async function safeRun(sql: string, params: any[] = []): Promise<void> {
  try {
    await query(sql, params)
  } catch {
    // Best-effort — never block the sweep on a bad write.
  }
}

let logEnsured = false
async function ensureReminderLog(): Promise<void> {
  if (logEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruitment_reminder_log (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      dedupe_key VARCHAR(190) NOT NULL,
      event_key VARCHAR(60) NOT NULL,
      source_module VARCHAR(60) DEFAULT NULL,
      source_ref VARCHAR(80) DEFAULT NULL,
      to_email VARCHAR(190) DEFAULT NULL,
      email_status VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_recruit_reminder (dedupe_key),
      KEY idx_recruit_reminder_ref (source_module, source_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})
  logEnsured = true
}

/** Atomically claim a dedupe key — only the first caller for this key wins. */
async function claim(dedupeKey: string, event: string, sourceModule: string, sourceRef: string): Promise<boolean> {
  try {
    const res = (await query(
      `INSERT IGNORE INTO recruitment_reminder_log (dedupe_key, event_key, source_module, source_ref, email_status)
       VALUES (?, ?, ?, ?, 'Notified')`,
      [dedupeKey, event, sourceModule, sourceRef],
    )) as any
    return Number(res?.affectedRows ?? 0) > 0
  } catch {
    return false
  }
}

/** Parse a comma-separated day list ("7,3,1") into a sorted, de-duplicated, positive-int array. */
function parseDayTiers(raw: string | undefined, fallback: string): number[] {
  const source = String(raw ?? "").trim() || fallback
  const tiers = new Set<number>()
  for (const part of source.split(/[,\s]+/)) {
    const n = Number(part)
    if (Number.isFinite(n) && n >= 0) tiers.add(Math.round(n))
  }
  return [...tiers].sort((a, b) => b - a)
}

type AutomationConfig = {
  offerExpiryReminderDays: number[]
  joiningReminderDays: number[]
  offerAutoExpire: boolean
}

/** Read the configurable offer/joining automation settings from Recruitment Settings. */
export async function getAutomationConfig(): Promise<AutomationConfig> {
  const rows = await safeRows(
    `SELECT LOWER(setting_name) AS name, setting_value AS value
       FROM recruitment_settings
      WHERE setting_name IS NOT NULL`,
  )
  const map = new Map<string, string>()
  for (const r of rows) map.set(String(r.name).trim(), String(r.value ?? "").trim())

  const truthy = (v: string | undefined) => ["yes", "true", "1", "on", "enabled"].includes(String(v ?? "").toLowerCase())

  return {
    offerExpiryReminderDays: parseDayTiers(map.get("offer_expiry_reminder_days"), DEFAULTS.offer_expiry_reminder_days),
    joiningReminderDays: parseDayTiers(map.get("joining_reminder_days"), DEFAULTS.joining_reminder_days),
    offerAutoExpire: map.has("offer_auto_expire") ? truthy(map.get("offer_auto_expire")) : DEFAULTS.offer_auto_expire,
  }
}

/** Notify the offer owner (falls back to the application owner). Both are user ids. */
async function ownerUserId(offer: any): Promise<number | null> {
  const direct = Number(offer?.created_by)
  if (Number.isFinite(direct) && direct > 0) return direct
  const appId = String(offer?.application_id ?? "").trim()
  if (!appId) return null
  const rows = await safeRows(`SELECT created_by FROM recruit_applications WHERE application_id = ? LIMIT 1`, [appId])
  const app = Number(rows[0]?.created_by)
  return Number.isFinite(app) && app > 0 ? app : null
}

function toDateOnly(v: any): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

export type OfferJoiningResult = {
  offerExpiryReminders: number
  offersExpired: number
  offerLapsedNotices: number
  joiningReminders: number
  autoExpireEnabled: boolean
}

/**
 * Scheduled offer-expiry + joining sweep. Sends de-duplicated in-app
 * notifications to the owning recruiter and, when configured, marks lapsed
 * offers expired (never accepted ones). Returns counts for the cron response.
 */
export async function runOfferAndJoiningAutomation(): Promise<OfferJoiningResult> {
  await ensureReminderLog()
  try {
    await ensureLeadLifecycleSchema()
  } catch {
    // notify() is itself best-effort; continue regardless.
  }

  const config = await getAutomationConfig()
  const result: OfferJoiningResult = {
    offerExpiryReminders: 0,
    offersExpired: 0,
    offerLapsedNotices: 0,
    joiningReminders: 0,
    autoExpireEnabled: config.offerAutoExpire,
  }

  const placeholders = TERMINAL_OFFER_STATUSES.map(() => "?").join(",")

  /* ------------------------- Phase 69 — before expiry --------------------- */
  // Live offers whose expiry_date is exactly one of the configured tiers away.
  if (config.offerExpiryReminderDays.length) {
    const liveOffers = await safeRows(
      `SELECT offer_id, application_id, candidate_name, job_title, expiry_date, created_by,
              DATEDIFF(expiry_date, CURDATE()) AS days_left
         FROM recruit_offers
        WHERE expiry_date IS NOT NULL
          AND expiry_date >= CURDATE()
          AND LOWER(COALESCE(status,'')) NOT IN (${placeholders})`,
      [...TERMINAL_OFFER_STATUSES],
    )
    for (const o of liveOffers) {
      const daysLeft = Number(o.days_left)
      if (!config.offerExpiryReminderDays.includes(daysLeft)) continue
      const expiry = toDateOnly(o.expiry_date)
      const claimed = await claim(
        `offer_expiry_warning:${o.offer_id}:${expiry}:t${daysLeft}`,
        "offer_expiry_warning",
        "recruit_offers",
        String(o.offer_id),
      )
      if (!claimed) continue
      const userId = await ownerUserId(o)
      if (userId) {
        await notify(null, {
          userId,
          type: "warning",
          title: `Offer expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}: ${o.candidate_name || o.offer_id}`,
          body: `The offer for ${o.candidate_name || "this candidate"}${o.job_title ? ` (${o.job_title})` : ""} expires on ${expiry}. Follow up to secure acceptance before it lapses.`,
          link: "/modules/recruitment/selection-offers",
          entityType: "recruitment_offer",
          entityId: String(o.offer_id),
        }).catch(() => {})
      }
      result.offerExpiryReminders += 1
    }
  }

  /* --------------------- Phase 69 — after expiry (lapsed) ------------------ */
  const lapsedOffers = await safeRows(
    `SELECT offer_id, application_id, candidate_name, job_title, expiry_date, created_by
       FROM recruit_offers
      WHERE expiry_date IS NOT NULL
        AND expiry_date < CURDATE()
        AND LOWER(COALESCE(status,'')) NOT IN (${placeholders})`,
    [...TERMINAL_OFFER_STATUSES],
  )
  for (const o of lapsedOffers) {
    const expiry = toDateOnly(o.expiry_date)
    // One notice per offer per expiry date, regardless of the auto-expire rule.
    const claimed = await claim(
      `offer_lapsed:${o.offer_id}:${expiry}`,
      "offer_lapsed",
      "recruit_offers",
      String(o.offer_id),
    )
    if (!claimed) continue

    if (config.offerAutoExpire) {
      // Business rule allows auto-expiry. The WHERE clause already excludes
      // accepted/terminal offers, so an accepted offer is never altered.
      await safeRun(
        `UPDATE recruit_offers SET status = 'expired'
          WHERE offer_id = ? AND LOWER(COALESCE(status,'')) NOT IN (${placeholders})`,
        [String(o.offer_id), ...TERMINAL_OFFER_STATUSES],
      )
      // Keep the application + candidate master in step (expired -> selected).
      await syncOfferStatus({ offerId: String(o.offer_id), status: "expired" }).catch(() => {})
      result.offersExpired += 1
    }

    const userId = await ownerUserId(o)
    if (userId) {
      await notify(null, {
        userId,
        type: "warning",
        title: `${config.offerAutoExpire ? "Offer expired" : "Offer past expiry"}: ${o.candidate_name || o.offer_id}`,
        body: config.offerAutoExpire
          ? `The offer for ${o.candidate_name || "this candidate"}${o.job_title ? ` (${o.job_title})` : ""} passed its expiry date (${expiry}) and was marked expired. The candidate remains available for re-offer.`
          : `The offer for ${o.candidate_name || "this candidate"}${o.job_title ? ` (${o.job_title})` : ""} passed its expiry date (${expiry}). Review whether to extend, re-offer or close it.`,
        link: "/modules/recruitment/selection-offers",
        entityType: "recruitment_offer",
        entityId: String(o.offer_id),
      }).catch(() => {})
    }
    result.offerLapsedNotices += 1
  }

  /* --------------------------- Phase 70 — joining ------------------------- */
  if (config.joiningReminderDays.length) {
    const joiners = await safeRows(
      `SELECT offer_id, application_id, candidate_name, job_title, joining_date, created_by,
              DATEDIFF(joining_date, CURDATE()) AS days_left
         FROM recruit_offers
        WHERE joining_date IS NOT NULL
          AND joining_date >= CURDATE()
          AND LOWER(COALESCE(status,'')) = 'accepted'`,
    )
    for (const o of joiners) {
      const daysLeft = Number(o.days_left)
      if (!config.joiningReminderDays.includes(daysLeft)) continue
      const joining = toDateOnly(o.joining_date)
      const claimed = await claim(
        `joining_reminder:${o.offer_id}:${joining}:t${daysLeft}`,
        "joining_reminder",
        "recruit_offers",
        String(o.offer_id),
      )
      if (!claimed) continue
      const userId = await ownerUserId(o)
      if (userId) {
        await notify(null, {
          userId,
          type: "info",
          title: `Joining in ${daysLeft} day${daysLeft === 1 ? "" : "s"}: ${o.candidate_name || o.offer_id}`,
          body: `${o.candidate_name || "This candidate"}${o.job_title ? ` (${o.job_title})` : ""} is due to join on ${joining}. Confirm pre-joining formalities and onboarding readiness.`,
          link: "/modules/recruitment/pre-joining",
          entityType: "recruitment_offer",
          entityId: String(o.offer_id),
        }).catch(() => {})
      }
      result.joiningReminders += 1
    }
  }

  return result
}
