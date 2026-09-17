import "server-only"
import crypto from "crypto"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { recordAudit } from "@/lib/sales/lead-lifecycle"

/**
 * Website Analytics & Conversion Tracking service.
 *
 * This is the ONE place that owns the analytics tracking engine:
 *   - `wa_properties`  : a tracked website/property + its server-generated
 *                        tracking id (the public identifier the script uses).
 *   - `wa_events`      : append-only raw event log (page views, sessions,
 *                        clicks, form events, conversions, custom events …).
 *   - `wa_sessions`    : per-session rollup maintained on ingestion so avg
 *                        session / bounce / landing / exit pages are real.
 *   - `wa_goals`       : configurable conversion goals (event or URL match).
 *
 * It NEVER creates its own Contact / Lead / Campaign / Email systems — campaign
 * attribution is done by matching captured UTM parameters against the existing
 * `marketing_email_campaigns` master, and lead conversions are recorded as
 * real events fired by the existing Lead Generation forms.
 *
 * All visible metrics are computed from these tables — there are no hard-coded
 * visitor / pageview / bounce numbers anywhere.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const PROPERTY_STATUSES = ["Active", "Paused", "Archived"] as const
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number]

export const GOAL_STATUSES = ["Active", "Paused"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const GOAL_MATCH_TYPES = ["event", "url"] as const
export type GoalMatchType = (typeof GOAL_MATCH_TYPES)[number]

/**
 * The event vocabulary the engine understands. Anything else is accepted and
 * stored as a custom event (so admins can configure their own event names)
 * but only these drive the built-in funnel / conversion logic.
 */
export const KNOWN_EVENT_TYPES = [
  "page_view",
  "session_start",
  "session_end",
  "page_enter",
  "page_exit",
  "scroll",
  "click",
  "form_view",
  "form_start",
  "form_submit",
  "form_error",
  "form_abandon",
  "cta_click",
  "outbound_link",
  "download",
  "video_play",
  "video_progress",
  "video_complete",
  "search",
  "lead_conversion",
  "custom",
] as const

/** Events that count a visitor as "engaged" for the funnel. */
const ENGAGEMENT_EVENTS = new Set([
  "scroll",
  "click",
  "cta_click",
  "form_start",
  "form_submit",
  "download",
  "video_play",
  "search",
  "outbound_link",
])

/** Events that (by default) count as a conversion / lead. */
const CONVERSION_EVENTS = new Set(["form_submit", "lead_conversion"])

export class PropertyNotFoundError extends Error {
  constructor(message = "Property not found") {
    super(message)
    this.name = "PropertyNotFoundError"
  }
}

export class IngestRejectedError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "IngestRejectedError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors a migration for existing databases)
// ---------------------------------------------------------------------------

let ensured = false

export async function ensureWebsiteAnalyticsSchema(): Promise<void> {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS wa_properties (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      property_code VARCHAR(40) NOT NULL,
      tracking_id VARCHAR(48) NOT NULL,
      name VARCHAR(190) NOT NULL,
      domain VARCHAR(190) NULL,
      status ENUM('Active','Paused','Archived') NOT NULL DEFAULT 'Active',
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      session_timeout_minutes INT UNSIGNED NOT NULL DEFAULT 30,
      retention_days INT UNSIGNED NOT NULL DEFAULT 400,
      exclude_bots TINYINT(1) NOT NULL DEFAULT 1,
      internal_ips VARCHAR(500) NULL,
      last_event_at DATETIME NULL,
      created_by INT UNSIGNED NULL,
      archived_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wap_code (property_code),
      UNIQUE KEY uq_wap_tracking (tracking_id),
      KEY idx_wap_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS wa_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      property_id BIGINT UNSIGNED NOT NULL,
      tracking_id VARCHAR(48) NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      event_name VARCHAR(120) NULL,
      visitor_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      page_url VARCHAR(1000) NULL,
      page_path VARCHAR(500) NULL,
      page_title VARCHAR(300) NULL,
      referrer VARCHAR(1000) NULL,
      referrer_domain VARCHAR(190) NULL,
      channel VARCHAR(30) NULL,
      utm_source VARCHAR(190) NULL,
      utm_medium VARCHAR(190) NULL,
      utm_campaign VARCHAR(190) NULL,
      utm_term VARCHAR(190) NULL,
      utm_content VARCHAR(190) NULL,
      device_type VARCHAR(20) NULL,
      browser VARCHAR(40) NULL,
      os VARCHAR(40) NULL,
      screen_size VARCHAR(20) NULL,
      language VARCHAR(20) NULL,
      country VARCHAR(60) NULL,
      region VARCHAR(90) NULL,
      city VARCHAR(90) NULL,
      duration_ms INT UNSIGNED NULL,
      is_bot TINYINT(1) NOT NULL DEFAULT 0,
      is_test TINYINT(1) NOT NULL DEFAULT 0,
      metadata JSON NULL,
      occurred_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_wae_prop_time (property_id, occurred_at),
      KEY idx_wae_prop_type (property_id, event_type, occurred_at),
      KEY idx_wae_session (session_id),
      KEY idx_wae_visitor (visitor_id),
      KEY idx_wae_path (property_id, page_path(120)),
      KEY idx_wae_channel (property_id, channel),
      KEY idx_wae_realtime (property_id, is_bot, is_test, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS wa_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      property_id BIGINT UNSIGNED NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      visitor_id VARCHAR(64) NOT NULL,
      started_at DATETIME NOT NULL,
      last_seen_at DATETIME NOT NULL,
      ended_at DATETIME NULL,
      landing_page VARCHAR(500) NULL,
      exit_page VARCHAR(500) NULL,
      pageview_count INT UNSIGNED NOT NULL DEFAULT 0,
      event_count INT UNSIGNED NOT NULL DEFAULT 0,
      engaged TINYINT(1) NOT NULL DEFAULT 0,
      converted TINYINT(1) NOT NULL DEFAULT 0,
      channel VARCHAR(30) NULL,
      referrer_domain VARCHAR(190) NULL,
      utm_source VARCHAR(190) NULL,
      utm_medium VARCHAR(190) NULL,
      utm_campaign VARCHAR(190) NULL,
      campaign_id BIGINT UNSIGNED NULL,
      device_type VARCHAR(20) NULL,
      browser VARCHAR(40) NULL,
      os VARCHAR(40) NULL,
      country VARCHAR(60) NULL,
      is_bot TINYINT(1) NOT NULL DEFAULT 0,
      is_test TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_was_session (property_id, session_id),
      KEY idx_was_prop_time (property_id, started_at),
      KEY idx_was_visitor (property_id, visitor_id),
      KEY idx_was_channel (property_id, channel),
      KEY idx_was_campaign (campaign_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS wa_goals (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      property_id BIGINT UNSIGNED NOT NULL,
      goal_code VARCHAR(40) NOT NULL,
      name VARCHAR(190) NOT NULL,
      match_type ENUM('event','url') NOT NULL DEFAULT 'event',
      event_type VARCHAR(40) NULL,
      target VARCHAR(500) NULL,
      status ENUM('Active','Paused') NOT NULL DEFAULT 'Active',
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wag_code (goal_code),
      KEY idx_wag_prop (property_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Register module features so the permission matrix can gate this screen.
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Website Analytics','marketing.website_analytics.view','View website analytics and conversion reports',70 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Website Analytics','marketing.website_analytics.manage','Manage tracked properties, goals, tracking config and exports',71 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})

  // Seed a default property on first run so the screen is usable immediately.
  const existing = await query<any[]>(`SELECT id FROM wa_properties LIMIT 1`)
  if (!existing.length) {
    await createProperty(
      { name: "Muenot Website", domain: "", timezone: "Asia/Kolkata", currency: "INR" },
      null,
    ).catch((e) => console.error("[wa] seed property failed", e))
  }

  ensured = true
}

// ---------------------------------------------------------------------------
// Property management (Phases 3, 4, 80)
// ---------------------------------------------------------------------------

export type WAProperty = {
  id: number
  property_code: string
  tracking_id: string
  name: string
  domain: string | null
  status: PropertyStatus
  timezone: string
  currency: string
  session_timeout_minutes: number
  retention_days: number
  exclude_bots: number
  internal_ips: string | null
  last_event_at: string | null
  created_at: string
  updated_at: string
  [key: string]: unknown
}

function generateTrackingId(): string {
  // Public, unguessable, non-sensitive identifier. Never derived from DB creds.
  return "MU-" + crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 12).toUpperCase()
}

const PROPERTY_WRITABLE = new Set([
  "name",
  "domain",
  "timezone",
  "currency",
  "session_timeout_minutes",
  "retention_days",
  "exclude_bots",
  "internal_ips",
])

function buildPropertyColumns(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of Object.keys(body)) {
    if (!PROPERTY_WRITABLE.has(key)) continue
    let value = body[key]
    if (value === "") value = null
    if (key === "exclude_bots") value = value ? 1 : 0
    if (key === "session_timeout_minutes") value = Math.max(1, Math.min(240, Number(value) || 30))
    if (key === "retention_days") value = Math.max(30, Math.min(2000, Number(value) || 400))
    if (key === "domain" && value) value = normalizeDomain(String(value))
    out[key] = value
  }
  return out
}

export async function listProperties(includeArchived = false): Promise<WAProperty[]> {
  const where = includeArchived ? "" : "WHERE archived_at IS NULL"
  return query<WAProperty[]>(`SELECT * FROM wa_properties ${where} ORDER BY created_at ASC`)
}

export async function getPropertyById(id: number): Promise<WAProperty | null> {
  const rows = await query<WAProperty[]>(`SELECT * FROM wa_properties WHERE id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

export async function getPropertyByTrackingId(trackingId: string): Promise<WAProperty | null> {
  const rows = await query<WAProperty[]>(
    `SELECT * FROM wa_properties WHERE tracking_id = ? AND archived_at IS NULL LIMIT 1`,
    [trackingId],
  )
  return rows[0] ?? null
}

export async function createProperty(
  body: Record<string, any>,
  actorId: number | null,
): Promise<{ id: number; property_code: string; tracking_id: string }> {
  const columns = buildPropertyColumns(body)
  if (!columns.name) throw new IngestRejectedError("A website name is required", 400)
  const code = await nextRecordId("WAP", { allowCustom: true, digits: 4 })
  const trackingId = generateTrackingId()
  const fields = ["property_code", "tracking_id", ...Object.keys(columns), "created_by"]
  const values = [code, trackingId, ...Object.keys(columns).map((k) => columns[k]), actorId]
  const res = await query<any>(
    `INSERT INTO wa_properties (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
    values,
  )
  if (actorId) {
    await recordAudit(null, {
      entityType: "wa_property",
      entityId: code,
      action: "created",
      summary: `Analytics property "${columns.name}" created`,
      actorId,
    })
  }
  return { id: Number(res.insertId), property_code: code, tracking_id: trackingId }
}

export async function updateProperty(id: number, body: Record<string, any>, actorId: number): Promise<void> {
  const prop = await getPropertyById(id)
  if (!prop) throw new PropertyNotFoundError()
  const columns = buildPropertyColumns(body)
  if (Object.keys(columns).length) {
    const sets = Object.keys(columns).map((k) => `${k} = ?`)
    await query(`UPDATE wa_properties SET ${sets.join(", ")} WHERE id = ?`, [
      ...Object.keys(columns).map((k) => columns[k]),
      id,
    ])
  }
  if (body.status && (PROPERTY_STATUSES as readonly string[]).includes(body.status)) {
    const archivedAt = body.status === "Archived" ? new Date() : null
    await query(`UPDATE wa_properties SET status = ?, archived_at = ? WHERE id = ?`, [body.status, archivedAt, id])
  }
  await recordAudit(null, {
    entityType: "wa_property",
    entityId: prop.property_code,
    action: "tracking_config_changed",
    summary: `Analytics property "${prop.name}" updated`,
    meta: columns,
    actorId,
  })
}

// ---------------------------------------------------------------------------
// Goals (Phases 46, 47)
// ---------------------------------------------------------------------------

export type WAGoal = {
  id: number
  property_id: number
  goal_code: string
  name: string
  match_type: GoalMatchType
  event_type: string | null
  target: string | null
  status: GoalStatus
  created_at: string
  updated_at: string
}

export async function listGoals(propertyId: number): Promise<WAGoal[]> {
  return query<WAGoal[]>(`SELECT * FROM wa_goals WHERE property_id = ? ORDER BY created_at ASC`, [propertyId])
}

export async function createGoal(propertyId: number, body: Record<string, any>, actorId: number): Promise<WAGoal> {
  const name = String(body.name ?? "").trim()
  if (!name) throw new IngestRejectedError("Goal name is required", 400)
  const matchType: GoalMatchType = (GOAL_MATCH_TYPES as readonly string[]).includes(body.match_type)
    ? body.match_type
    : "event"
  const code = await nextRecordId("WAG", { allowCustom: true, digits: 4 })
  const eventType = matchType === "event" ? String(body.event_type || "form_submit").slice(0, 40) : null
  const target = matchType === "url" ? String(body.target || "").slice(0, 500) : (body.target ? String(body.target).slice(0, 500) : null)
  const res = await query<any>(
    `INSERT INTO wa_goals (property_id, goal_code, name, match_type, event_type, target, status, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [propertyId, code, name.slice(0, 190), matchType, eventType, target, "Active", actorId],
  )
  await recordAudit(null, {
    entityType: "wa_goal",
    entityId: code,
    action: "goal_created",
    summary: `Conversion goal "${name}" created`,
    actorId,
  })
  const rows = await query<WAGoal[]>(`SELECT * FROM wa_goals WHERE id = ? LIMIT 1`, [Number(res.insertId)])
  return rows[0]
}

export async function updateGoal(id: number, body: Record<string, any>, actorId: number): Promise<void> {
  const rows = await query<WAGoal[]>(`SELECT * FROM wa_goals WHERE id = ? LIMIT 1`, [id])
  const goal = rows[0]
  if (!goal) throw new IngestRejectedError("Goal not found", 404)
  const sets: string[] = []
  const args: any[] = []
  if (body.name != null) {
    sets.push("name = ?")
    args.push(String(body.name).slice(0, 190))
  }
  if (body.status && (GOAL_STATUSES as readonly string[]).includes(body.status)) {
    sets.push("status = ?")
    args.push(body.status)
  }
  if (body.event_type != null) {
    sets.push("event_type = ?")
    args.push(String(body.event_type).slice(0, 40))
  }
  if (body.target != null) {
    sets.push("target = ?")
    args.push(String(body.target).slice(0, 500))
  }
  if (sets.length) {
    args.push(id)
    await query(`UPDATE wa_goals SET ${sets.join(", ")} WHERE id = ?`, args)
  }
  await recordAudit(null, {
    entityType: "wa_goal",
    entityId: goal.goal_code,
    action: "goal_updated",
    summary: `Conversion goal "${goal.name}" updated`,
    actorId,
  })
}

export async function deleteGoal(id: number, actorId: number): Promise<void> {
  const rows = await query<WAGoal[]>(`SELECT * FROM wa_goals WHERE id = ? LIMIT 1`, [id])
  const goal = rows[0]
  if (!goal) return
  await query(`DELETE FROM wa_goals WHERE id = ?`, [id])
  await recordAudit(null, {
    entityType: "wa_goal",
    entityId: goal.goal_code,
    action: "goal_deleted",
    summary: `Conversion goal "${goal.name}" deleted`,
    actorId,
  })
}

// ---------------------------------------------------------------------------
// Helpers: normalization, UA parsing, channel classification, bot detection
// ---------------------------------------------------------------------------

export function normalizeDomain(input: string): string {
  let d = String(input || "").trim().toLowerCase()
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "")
  d = d.split("/")[0]
  return d.slice(0, 190)
}

function referrerDomain(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  try {
    return normalizeDomain(new URL(referrer).hostname) || null
  } catch {
    return null
  }
}

function pagePath(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null
  try {
    const u = new URL(pageUrl)
    return (u.pathname || "/").slice(0, 500)
  } catch {
    // Already a path?
    const p = String(pageUrl).split("?")[0]
    return p ? p.slice(0, 500) : null
  }
}

const SEARCH_ENGINES = ["google.", "bing.", "yahoo.", "duckduckgo.", "yandex.", "baidu.", "ecosia.", "brave."]
const SOCIAL_DOMAINS = [
  "facebook.",
  "fb.",
  "instagram.",
  "twitter.",
  "t.co",
  "x.com",
  "linkedin.",
  "lnkd.in",
  "youtube.",
  "youtu.be",
  "tiktok.",
  "pinterest.",
  "reddit.",
  "whatsapp.",
  "wa.me",
  "telegram.",
  "t.me",
]

/** Classify a visit into a marketing channel (Phase 20). */
export function classifyChannel(opts: {
  utmSource?: string | null
  utmMedium?: string | null
  referrerDomain?: string | null
  selfDomain?: string | null
}): string {
  const medium = (opts.utmMedium || "").toLowerCase()
  const source = (opts.utmSource || "").toLowerCase()
  const ref = (opts.referrerDomain || "").toLowerCase()

  if (medium) {
    if (/(cpc|ppc|paid|paidsearch|display|cpm|banner)/.test(medium)) return "Paid"
    if (/email|newsletter/.test(medium)) return "Email"
    if (/social|whatsapp/.test(medium)) return "Social"
    if (/referral/.test(medium)) return "Referral"
    if (/organic/.test(medium)) return "Organic Search"
  }
  if (source) {
    if (/whatsapp/.test(source)) return "Social"
    if (SOCIAL_DOMAINS.some((s) => source.includes(s.replace(/\.$/, "")))) return "Social"
    if (/email|newsletter|mailchimp|sendgrid/.test(source)) return "Email"
    if (SEARCH_ENGINES.some((s) => source.includes(s.replace(/\.$/, "")))) return "Organic Search"
  }
  if (!ref || (opts.selfDomain && ref === normalizeDomain(opts.selfDomain))) return "Direct"
  if (SEARCH_ENGINES.some((s) => ref.includes(s))) return "Organic Search"
  if (SOCIAL_DOMAINS.some((s) => ref.includes(s))) return "Social"
  return "Referral"
}

/** Minimal, dependency-free UA parsing — coarse categories only (Phases 29-32). */
export function parseUserAgent(ua: string): { device_type: string; browser: string; os: string } {
  const s = (ua || "").toLowerCase()
  let device_type = "Desktop"
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) device_type = "Tablet"
  else if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/.test(s)) device_type = "Mobile"

  let browser = "Other"
  if (/edg\//.test(s)) browser = "Edge"
  else if (/opr\/|opera/.test(s)) browser = "Opera"
  else if (/samsungbrowser/.test(s)) browser = "Samsung Internet"
  else if (/chrome|crios/.test(s)) browser = "Chrome"
  else if (/firefox|fxios/.test(s)) browser = "Firefox"
  else if (/safari/.test(s)) browser = "Safari"
  else if (/msie|trident/.test(s)) browser = "Internet Explorer"

  let os = "Other"
  if (/windows/.test(s)) os = "Windows"
  else if (/android/.test(s)) os = "Android"
  else if (/iphone|ipad|ipod|ios/.test(s)) os = "iOS"
  else if (/mac os x|macintosh/.test(s)) os = "macOS"
  else if (/linux/.test(s)) os = "Linux"

  return { device_type, browser, os }
}

const BOT_RE =
  /(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link|pinterest|redditbot|whatsapp|telegrambot|headless|puppeteer|playwright|phantomjs|lighthouse|gtmetrix|pingdom|uptimerobot|monitor|curl|wget|python-requests|axios|node-fetch|go-http|semrush|ahrefs|dotbot|mj12bot|screaming frog)/i

/** Best-effort bot detection — never claims to be perfect (Phase 83). */
export function looksLikeBot(ua: string): boolean {
  if (!ua) return true
  return BOT_RE.test(ua)
}

function parseJson(value: any): any {
  if (value == null) return null
  if (typeof value === "object") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Event ingestion + sessionization (Phases 2, 8, 38)
// ---------------------------------------------------------------------------

export type IngestContext = {
  userAgent: string
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
}

export type IncomingEvent = {
  type: string
  name?: string | null
  visitor_id: string
  session_id: string
  page_url?: string | null
  page_title?: string | null
  referrer?: string | null
  utm?: Record<string, string> | null
  screen_size?: string | null
  language?: string | null
  duration_ms?: number | null
  is_test?: boolean
  metadata?: Record<string, unknown> | null
  ts?: number | null
}

function sanitizeMetadata(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object") return null
  // Privacy (Phase 6): strip anything that looks like a secret / card / password.
  const banned = /(password|passwd|pwd|card|cvv|cvc|ssn|secret|token|otp|pin|auth)/i
  const out: Record<string, unknown> = {}
  let count = 0
  for (const [k, v] of Object.entries(meta)) {
    if (count >= 25) break
    if (banned.test(k)) continue
    if (typeof v === "object" && v !== null) continue
    const val = typeof v === "string" ? v.slice(0, 300) : v
    out[k] = val
    count++
  }
  return Object.keys(out).length ? out : null
}

/**
 * Ingest a validated batch of events for one property. Writes the raw events
 * and maintains the per-session rollup so downstream metrics are real.
 */
export async function ingestEvents(
  property: WAProperty,
  events: IncomingEvent[],
  ctx: IngestContext,
): Promise<{ accepted: number }> {
  const isBot = property.exclude_bots ? looksLikeBot(ctx.userAgent) : looksLikeBot(ctx.userAgent)
  const ua = parseUserAgent(ctx.userAgent)
  const selfDomain = property.domain || null
  let accepted = 0

  for (const ev of events) {
    const type = String(ev.type || "").slice(0, 40)
    if (!type) continue
    const visitorId = String(ev.visitor_id || "").slice(0, 64)
    const sessionId = String(ev.session_id || "").slice(0, 64)
    if (!visitorId || !sessionId) continue

    const utm = ev.utm || {}
    const refDomain = referrerDomain(ev.referrer)
    const channel = classifyChannel({
      utmSource: utm.utm_source,
      utmMedium: utm.utm_medium,
      referrerDomain: refDomain,
      selfDomain,
    })
    const path = pagePath(ev.page_url)
    const occurredAt = ev.ts ? new Date(Number(ev.ts)) : new Date()
    const occurredSql = toSql(occurredAt)
    const isTest = ev.is_test ? 1 : 0

    await query(
      `INSERT INTO wa_events
        (property_id, tracking_id, event_type, event_name, visitor_id, session_id,
         page_url, page_path, page_title, referrer, referrer_domain, channel,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         device_type, browser, os, screen_size, language, country, region, city,
         duration_ms, is_bot, is_test, metadata, occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        property.id,
        property.tracking_id,
        type,
        ev.name ? String(ev.name).slice(0, 120) : null,
        visitorId,
        sessionId,
        ev.page_url ? String(ev.page_url).slice(0, 1000) : null,
        path,
        ev.page_title ? String(ev.page_title).slice(0, 300) : null,
        ev.referrer ? String(ev.referrer).slice(0, 1000) : null,
        refDomain,
        channel,
        utm.utm_source?.slice(0, 190) || null,
        utm.utm_medium?.slice(0, 190) || null,
        utm.utm_campaign?.slice(0, 190) || null,
        utm.utm_term?.slice(0, 190) || null,
        utm.utm_content?.slice(0, 190) || null,
        ua.device_type,
        ua.browser,
        ua.os,
        ev.screen_size ? String(ev.screen_size).slice(0, 20) : null,
        ev.language ? String(ev.language).slice(0, 20) : null,
        ctx.country,
        ctx.region,
        ctx.city,
        ev.duration_ms != null ? Math.max(0, Math.min(86_400_000, Number(ev.duration_ms) || 0)) : null,
        isBot ? 1 : 0,
        isTest,
        JSON.stringify(sanitizeMetadata(ev.metadata) ?? {}),
        occurredSql,
      ],
    )

    await upsertSession(property, ev, {
      channel,
      refDomain,
      device: ua,
      country: ctx.country,
      isBot: isBot ? 1 : 0,
      isTest,
      occurredSql,
      path,
      type,
    })
    accepted++
  }

  if (accepted > 0) {
    await query(`UPDATE wa_properties SET last_event_at = ? WHERE id = ?`, [toSql(new Date()), property.id]).catch(
      () => {},
    )
  }
  return { accepted }
}

type SessionUpsertMeta = {
  channel: string
  refDomain: string | null
  device: { device_type: string; browser: string; os: string }
  country: string | null
  isBot: number
  isTest: number
  occurredSql: string
  path: string | null
  type: string
}

async function upsertSession(property: WAProperty, ev: IncomingEvent, m: SessionUpsertMeta): Promise<void> {
  const sessionId = String(ev.session_id).slice(0, 64)
  const visitorId = String(ev.visitor_id).slice(0, 64)
  const utm = ev.utm || {}
  const isPageview = m.type === "page_view" ? 1 : 0
  const isEngaged = ENGAGEMENT_EVENTS.has(m.type) ? 1 : 0
  const isConversion = CONVERSION_EVENTS.has(m.type) ? 1 : 0
  const campaignId = await matchCampaign(utm.utm_campaign)

  const existing = await query<any[]>(
    `SELECT id, pageview_count FROM wa_sessions WHERE property_id = ? AND session_id = ? LIMIT 1`,
    [property.id, sessionId],
  )

  if (!existing.length) {
    await query(
      `INSERT INTO wa_sessions
        (property_id, session_id, visitor_id, started_at, last_seen_at, landing_page, exit_page,
         pageview_count, event_count, engaged, converted, channel, referrer_domain,
         utm_source, utm_medium, utm_campaign, campaign_id, device_type, browser, os, country, is_bot, is_test)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         last_seen_at = VALUES(last_seen_at),
         exit_page = VALUES(exit_page),
         pageview_count = pageview_count + VALUES(pageview_count),
         event_count = event_count + 1,
         engaged = GREATEST(engaged, VALUES(engaged)),
         converted = GREATEST(converted, VALUES(converted))`,
      [
        property.id,
        sessionId,
        visitorId,
        m.occurredSql,
        m.occurredSql,
        m.path,
        m.path,
        isPageview,
        1,
        isEngaged,
        isConversion,
        m.channel,
        m.refDomain,
        utm.utm_source?.slice(0, 190) || null,
        utm.utm_medium?.slice(0, 190) || null,
        utm.utm_campaign?.slice(0, 190) || null,
        campaignId,
        m.device.device_type,
        m.device.browser,
        m.device.os,
        m.country,
        m.isBot,
        m.isTest,
      ],
    )
    return
  }

  await query(
    `UPDATE wa_sessions
       SET last_seen_at = GREATEST(last_seen_at, ?),
           ended_at = GREATEST(COALESCE(ended_at, ?), ?),
           exit_page = COALESCE(?, exit_page),
           pageview_count = pageview_count + ?,
           event_count = event_count + 1,
           engaged = GREATEST(engaged, ?),
           converted = GREATEST(converted, ?),
           campaign_id = COALESCE(campaign_id, ?)
     WHERE id = ?`,
    [
      m.occurredSql,
      m.occurredSql,
      m.occurredSql,
      m.path,
      isPageview,
      isEngaged,
      isConversion,
      campaignId,
      existing[0].id,
    ],
  )
}

/**
 * Campaign attribution (Phases 24-27): match a captured utm_campaign against
 * the EXISTING email-campaign master by code or name. Never creates a campaign.
 */
const campaignMatchCache = new Map<string, number | null>()
async function matchCampaign(utmCampaign?: string | null): Promise<number | null> {
  const key = (utmCampaign || "").trim().toLowerCase()
  if (!key) return null
  if (campaignMatchCache.has(key)) return campaignMatchCache.get(key)!
  let id: number | null = null
  try {
    const rows = await query<any[]>(
      `SELECT id FROM marketing_email_campaigns
        WHERE LOWER(campaign_code) = ? OR LOWER(name) = ? OR LOWER(REPLACE(name,' ','_')) = ?
        LIMIT 1`,
      [key, key, key],
    )
    id = rows.length ? Number(rows[0].id) : null
  } catch {
    id = null
  }
  campaignMatchCache.set(key, id)
  return id
}

function toSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}

// ---------------------------------------------------------------------------
// Date-range resolution (Phases 63, 64)
// ---------------------------------------------------------------------------

export type ResolvedRange = { from: string; to: string; prevFrom: string; prevTo: string; label: string }

export function resolveRange(range: string, fromParam?: string | null, toParam?: string | null): ResolvedRange {
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0)
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59)

  let from: Date
  let to: Date = endOfDay(now)

  switch (range) {
    case "today":
      from = startOfDay(now)
      break
    case "yesterday": {
      const y = new Date(now)
      y.setDate(y.getDate() - 1)
      from = startOfDay(y)
      to = endOfDay(y)
      break
    }
    case "7d":
      from = startOfDay(new Date(now.getTime() - 6 * 864e5))
      break
    case "month":
      from = new Date(now.getFullYear(), now.getMonth(), 1)
      break
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3)
      from = new Date(now.getFullYear(), q * 3, 1)
      break
    }
    case "year":
      from = new Date(now.getFullYear(), 0, 1)
      break
    case "custom": {
      from = fromParam ? startOfDay(new Date(fromParam)) : startOfDay(new Date(now.getTime() - 29 * 864e5))
      to = toParam ? endOfDay(new Date(toParam)) : endOfDay(now)
      break
    }
    case "30d":
    default:
      from = startOfDay(new Date(now.getTime() - 29 * 864e5))
      break
  }

  const spanMs = to.getTime() - from.getTime()
  const prevTo = new Date(from.getTime() - 1000)
  const prevFrom = new Date(prevTo.getTime() - spanMs)

  return {
    from: toSql(from),
    to: toSql(to),
    prevFrom: toSql(prevFrom),
    prevTo: toSql(prevTo),
    label: range || "30d",
  }
}

// ---------------------------------------------------------------------------
// Aggregation / reporting (Phases 10-18, 20-22, 28-37, 48-57, 65-76)
// ---------------------------------------------------------------------------

/** WHERE fragment excluding bots + test traffic and scoping to property + range. */
function baseFilter(propertyId: number, from: string, to: string) {
  return {
    sql: `property_id = ? AND is_bot = 0 AND is_test = 0 AND occurred_at BETWEEN ? AND ?`,
    args: [propertyId, from, to] as any[],
  }
}

async function scalar(sql: string, args: any[]): Promise<number> {
  const rows = await query<any[]>(sql, args)
  const v = rows[0] ? Object.values(rows[0])[0] : 0
  return Number(v || 0)
}

export type Kpis = {
  visitors: number
  pageviews: number
  uniquePageviews: number
  sessions: number
  avgSessionSeconds: number
  bounceRate: number
  conversions: number
  conversionRate: number
}

async function kpisForRange(propertyId: number, from: string, to: string): Promise<Kpis> {
  const ev = baseFilter(propertyId, from, to)
  const visitors = await scalar(
    `SELECT COUNT(DISTINCT visitor_id) FROM wa_events WHERE ${ev.sql} AND event_type = 'page_view'`,
    ev.args,
  )
  const pageviews = await scalar(
    `SELECT COUNT(*) FROM wa_events WHERE ${ev.sql} AND event_type = 'page_view'`,
    ev.args,
  )
  const uniquePageviews = await scalar(
    `SELECT COUNT(*) FROM (SELECT 1 FROM wa_events WHERE ${ev.sql} AND event_type = 'page_view' GROUP BY visitor_id, page_path) t`,
    ev.args,
  )

  // Sessions scoped by their start time.
  const sRows = await query<any[]>(
    `SELECT
        COUNT(*) AS sessions,
        AVG(TIMESTAMPDIFF(SECOND, started_at, last_seen_at)) AS avg_dur,
        SUM(CASE WHEN pageview_count <= 1 AND engaged = 0 THEN 1 ELSE 0 END) AS bounced,
        SUM(converted) AS conversions
       FROM wa_sessions
      WHERE property_id = ? AND is_bot = 0 AND is_test = 0 AND started_at BETWEEN ? AND ?`,
    [propertyId, from, to],
  )
  const sessions = Number(sRows[0]?.sessions || 0)
  const avgSessionSeconds = Math.round(Number(sRows[0]?.avg_dur || 0))
  const bounced = Number(sRows[0]?.bounced || 0)
  const conversions = Number(sRows[0]?.conversions || 0)
  const bounceRate = sessions ? (bounced / sessions) * 100 : 0
  const conversionRate = sessions ? (conversions / sessions) * 100 : 0

  return {
    visitors,
    pageviews,
    uniquePageviews,
    sessions,
    avgSessionSeconds,
    bounceRate: round1(bounceRate),
    conversions,
    conversionRate: round1(conversionRate),
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Full analytics payload for a property + range. */
export async function getAnalytics(
  propertyId: number,
  r: ResolvedRange,
  opts: { compare?: boolean } = {},
): Promise<Record<string, any>> {
  const ev = baseFilter(propertyId, r.from, r.to)

  const [kpis, prev] = await Promise.all([
    kpisForRange(propertyId, r.from, r.to),
    opts.compare ? kpisForRange(propertyId, r.prevFrom, r.prevTo) : Promise.resolve(null),
  ])

  const hasData = kpis.pageviews > 0 || kpis.sessions > 0

  // Traffic time-series (Phase 65, 66) — group by day.
  const traffic = await query<any[]>(
    `SELECT DATE(occurred_at) AS d,
            COUNT(DISTINCT CASE WHEN event_type='page_view' THEN visitor_id END) AS visitors,
            SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS pageviews
       FROM wa_events WHERE ${ev.sql}
      GROUP BY DATE(occurred_at) ORDER BY d ASC`,
    ev.args,
  )

  // Top pages (Phases 12, 13, 73).
  const topPages = await query<any[]>(
    `SELECT page_path AS path,
            MAX(page_title) AS title,
            COUNT(*) AS views,
            COUNT(DISTINCT visitor_id) AS uniques,
            ROUND(AVG(NULLIF(duration_ms,0))/1000) AS avg_seconds
       FROM wa_events
      WHERE ${ev.sql} AND event_type = 'page_view' AND page_path IS NOT NULL
      GROUP BY page_path ORDER BY views DESC LIMIT 15`,
    ev.args,
  )

  // Landing + exit pages (Phases 15, 16).
  const landingPages = await query<any[]>(
    `SELECT landing_page AS path,
            COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_id) AS visitors,
            SUM(converted) AS conversions,
            ROUND(SUM(converted)/COUNT(*)*100,1) AS conversion_rate
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ? AND landing_page IS NOT NULL
      GROUP BY landing_page ORDER BY sessions DESC LIMIT 10`,
    [propertyId, r.from, r.to],
  )
  const exitPages = await query<any[]>(
    `SELECT exit_page AS path, COUNT(*) AS exits
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ? AND exit_page IS NOT NULL
      GROUP BY exit_page ORDER BY exits DESC LIMIT 10`,
    [propertyId, r.from, r.to],
  )

  // Channels / sources (Phases 20, 53, 56).
  const channels = await query<any[]>(
    `SELECT channel,
            COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_id) AS visitors,
            SUM(converted) AS conversions
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ?
      GROUP BY channel ORDER BY sessions DESC`,
    [propertyId, r.from, r.to],
  )

  // Referrers (Phases 21, 55, 71).
  const referrers = await query<any[]>(
    `SELECT referrer_domain AS domain, COUNT(*) AS sessions, SUM(converted) AS conversions
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ? AND referrer_domain IS NOT NULL
      GROUP BY referrer_domain ORDER BY sessions DESC LIMIT 10`,
    [propertyId, r.from, r.to],
  )

  // UTM performance (Phases 23, 54).
  const utmPerformance = await query<any[]>(
    `SELECT COALESCE(utm_source,'(none)') AS source,
            COALESCE(utm_medium,'(none)') AS medium,
            COALESCE(utm_campaign,'(none)') AS campaign,
            COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_id) AS visitors,
            SUM(converted) AS conversions
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ?
        AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
      GROUP BY source, medium, campaign ORDER BY sessions DESC LIMIT 20`,
    [propertyId, r.from, r.to],
  )

  // Campaign attribution against the existing campaign master (Phases 52, 72).
  const campaigns = await query<any[]>(
    `SELECT c.id, c.name, c.campaign_code AS code,
            COUNT(*) AS sessions,
            COUNT(DISTINCT s.visitor_id) AS visitors,
            SUM(s.converted) AS conversions
       FROM wa_sessions s
       JOIN marketing_email_campaigns c ON c.id = s.campaign_id
      WHERE s.property_id = ? AND s.is_bot=0 AND s.is_test=0 AND s.started_at BETWEEN ? AND ?
      GROUP BY c.id, c.name, c.campaign_code ORDER BY sessions DESC LIMIT 10`,
    [propertyId, r.from, r.to],
  ).catch(() => [])

  // Device / browser / OS / geo (Phases 29-33, 69, 70).
  const devices = await groupSessions(propertyId, r, "device_type", "device")
  const browsers = await groupSessions(propertyId, r, "browser", "browser")
  const operatingSystems = await groupSessions(propertyId, r, "os", "os")
  const countries = await groupSessions(propertyId, r, "country", "country")

  // Event breakdown (Phases 38, 39, 58-62).
  const events = await query<any[]>(
    `SELECT event_type AS type, COUNT(*) AS count, COUNT(DISTINCT visitor_id) AS visitors
       FROM wa_events WHERE ${ev.sql}
      GROUP BY event_type ORDER BY count DESC`,
    ev.args,
  )

  // Funnel (Phases 48-50): Visitors -> Engaged -> Form started -> Conversions.
  const funnelRows = await query<any[]>(
    `SELECT
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(DISTINCT CASE WHEN event_type IN ('scroll','click','cta_click','search','video_play','download','outbound_link','form_start','form_submit') THEN visitor_id END) AS engaged,
        COUNT(DISTINCT CASE WHEN event_type IN ('form_start','form_view') THEN visitor_id END) AS form_started,
        COUNT(DISTINCT CASE WHEN event_type IN ('form_submit','lead_conversion') THEN visitor_id END) AS converted
       FROM wa_events WHERE ${ev.sql}`,
    ev.args,
  )
  const funnel = funnelRows[0] || { visitors: 0, engaged: 0, form_started: 0, converted: 0 }

  // Goals (Phases 46-49).
  const goals = await computeGoals(propertyId, r)

  return {
    hasData,
    range: { from: r.from, to: r.to, label: r.label },
    kpis,
    previous: prev,
    traffic,
    topPages,
    landingPages,
    exitPages,
    channels,
    referrers,
    utmPerformance,
    campaigns,
    devices,
    browsers,
    operatingSystems,
    countries,
    events,
    funnel: {
      visitors: Number(funnel.visitors || 0),
      engaged: Number(funnel.engaged || 0),
      form_started: Number(funnel.form_started || 0),
      converted: Number(funnel.converted || 0),
    },
    goals,
  }
}

async function groupSessions(
  propertyId: number,
  r: ResolvedRange,
  column: string,
  alias: string,
): Promise<any[]> {
  return query<any[]>(
    `SELECT COALESCE(${column},'Unknown') AS ${alias},
            COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_id) AS visitors,
            SUM(converted) AS conversions
       FROM wa_sessions
      WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ?
      GROUP BY ${column} ORDER BY sessions DESC LIMIT 12`,
    [propertyId, r.from, r.to],
  )
}

async function computeGoals(propertyId: number, r: ResolvedRange): Promise<any[]> {
  const goals = await listGoals(propertyId)
  const active = goals.filter((g) => g.status === "Active")
  const sessions = await scalar(
    `SELECT COUNT(*) FROM wa_sessions WHERE property_id = ? AND is_bot=0 AND is_test=0 AND started_at BETWEEN ? AND ?`,
    [propertyId, r.from, r.to],
  )
  const out: any[] = []
  for (const g of active) {
    let completions = 0
    if (g.match_type === "url") {
      completions = await scalar(
        `SELECT COUNT(DISTINCT session_id) FROM wa_events
          WHERE property_id = ? AND is_bot=0 AND is_test=0 AND occurred_at BETWEEN ? AND ?
            AND event_type = 'page_view' AND page_path = ?`,
        [propertyId, r.from, r.to, g.target || ""],
      )
    } else {
      completions = await scalar(
        `SELECT COUNT(DISTINCT session_id) FROM wa_events
          WHERE property_id = ? AND is_bot=0 AND is_test=0 AND occurred_at BETWEEN ? AND ?
            AND event_type = ?`,
        [propertyId, r.from, r.to, g.event_type || "form_submit"],
      )
    }
    out.push({
      id: g.id,
      name: g.name,
      match_type: g.match_type,
      event_type: g.event_type,
      target: g.target,
      completions,
      rate: sessions ? round1((completions / sessions) * 100) : 0,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Real-time (Phases 19, 77) + tracking health (Phases 78, 79)
// ---------------------------------------------------------------------------

export async function getRealtime(propertyId: number): Promise<Record<string, any>> {
  const windowSql = `property_id = ? AND is_bot=0 AND is_test=0 AND occurred_at >= (NOW() - INTERVAL 5 MINUTE)`
  const activeVisitors = await scalar(
    `SELECT COUNT(DISTINCT visitor_id) FROM wa_events WHERE ${windowSql}`,
    [propertyId],
  )
  const activeSessions = await scalar(
    `SELECT COUNT(DISTINCT session_id) FROM wa_events WHERE ${windowSql}`,
    [propertyId],
  )
  const currentPages = await query<any[]>(
    `SELECT page_path AS path, COUNT(DISTINCT visitor_id) AS visitors
       FROM wa_events WHERE ${windowSql} AND event_type='page_view' AND page_path IS NOT NULL
      GROUP BY page_path ORDER BY visitors DESC LIMIT 8`,
    [propertyId],
  )
  const recentEvents = await query<any[]>(
    `SELECT event_type AS type, event_name AS name, page_path AS path, channel, occurred_at
       FROM wa_events
      WHERE property_id = ? AND is_bot=0 AND is_test=0
      ORDER BY occurred_at DESC LIMIT 12`,
    [propertyId],
  )
  return { activeVisitors, activeSessions, currentPages, recentEvents }
}

export async function getTrackingHealth(property: WAProperty): Promise<Record<string, any>> {
  const eventsToday = await scalar(
    `SELECT COUNT(*) FROM wa_events WHERE property_id = ? AND is_bot=0 AND is_test=0 AND DATE(occurred_at) = CURDATE()`,
    [property.id],
  )
  const lastRows = await query<any[]>(
    `SELECT event_type, occurred_at FROM wa_events WHERE property_id = ? ORDER BY occurred_at DESC LIMIT 1`,
    [property.id],
  )
  const last = lastRows[0] || null
  const lastMs = last ? Date.now() - new Date(last.occurred_at.replace(" ", "T")).getTime() : null

  let status: "connected" | "warning" | "no_data" = "no_data"
  if (last) {
    if (lastMs != null && lastMs < 60 * 60 * 1000) status = "connected"
    else if (lastMs != null && lastMs < 72 * 60 * 60 * 1000) status = "warning"
    else status = "warning"
  }

  return {
    status,
    lastEventType: last?.event_type ?? null,
    lastEventAt: last?.occurred_at ?? null,
    eventsToday,
  }
}

// ---------------------------------------------------------------------------
// Retention cleanup (Phases 86, 87)
// ---------------------------------------------------------------------------

export async function purgeExpiredEvents(): Promise<number> {
  const props = await listProperties(true)
  let removed = 0
  for (const p of props) {
    const res = await query<any>(
      `DELETE FROM wa_events WHERE property_id = ? AND occurred_at < (NOW() - INTERVAL ? DAY) LIMIT 5000`,
      [p.id, p.retention_days || 400],
    ).catch(() => null)
    if (res) removed += Number(res.affectedRows || 0)
  }
  return removed
}

export { parseJson }
