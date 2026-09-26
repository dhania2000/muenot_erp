/**
 * Spec41 (#135-139, #218-219) — central communication governance.
 * Pure, dependency-free rules shared by the notification engine, email engine,
 * WhatsApp and calling: per-tenant provider configuration, suppression
 * (bounce / complaint / opt-out), consent keywords and send-limit windows.
 * Nothing here touches the database, so it is exhaustively unit-tested.
 */
import crypto from "node:crypto"

export const COMM_CHANNELS = ["email", "sms", "whatsapp", "push", "voice"] as const
export type CommChannel = (typeof COMM_CHANNELS)[number]

/** Allow-listed providers per channel. "platform" = the shared env transport. */
export const CHANNEL_PROVIDERS: Record<CommChannel, readonly string[]> = {
  email: ["platform", "smtp", "ses", "sendgrid", "resend"],
  sms: ["platform", "twilio", "msg91"],
  whatsapp: ["meta_cloud"],
  push: ["platform", "fcm"],
  voice: ["platform", "twilio", "webrtc"],
}

export const SUPPRESSION_REASONS = ["hard_bounce", "soft_bounce", "complaint", "opt_out", "manual"] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * Reasons an admin may NOT lift on the recipient's behalf. A complaint or an
 * opt-out is the recipient withdrawing consent; only the recipient re-opting
 * in (e.g. WhatsApp "START") can clear it.
 */
export const CONSENT_REASONS: readonly SuppressionReason[] = ["complaint", "opt_out"]

export const MAX_LIMIT = 1_000_000
export const SOFT_BOUNCE_THRESHOLD = 3

export type ProviderConfigInput = {
  channel: CommChannel
  provider: string
  enabled: boolean
  credentialRef: string | null
  hourlyLimit: number | null
  dailyLimit: number | null
  settings: Record<string, string | number | boolean>
}

export class GovernanceError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = "GovernanceError"
  }
}

export function isChannel(v: unknown): v is CommChannel {
  return typeof v === "string" && (COMM_CHANNELS as readonly string[]).includes(v)
}

const SECRET_KEY_RE = /(pass(word)?|secret|token|api[_-]?key|private|credential|auth)/i
const CREDENTIAL_REF_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/i
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

function limitOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_LIMIT) {
    throw new GovernanceError("invalid_limit", `${field} must be an integer between 0 and ${MAX_LIMIT}`)
  }
  return n
}

/**
 * Validate a tenant provider configuration. Secrets are NEVER accepted inline:
 * credentials must live in the tenant secrets vault and be referenced by
 * `credentialRef`. Any settings key that looks like a secret is rejected.
 */
export function validateProviderConfig(raw: unknown): ProviderConfigInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GovernanceError("invalid_body", "Invalid provider configuration")
  const b = raw as Record<string, unknown>
  if (!isChannel(b.channel)) throw new GovernanceError("invalid_channel", "Unknown channel")
  const provider = String(b.provider ?? "").trim().toLowerCase()
  if (!CHANNEL_PROVIDERS[b.channel].includes(provider)) {
    throw new GovernanceError("invalid_provider", `Provider "${provider}" is not supported for ${b.channel}`)
  }
  if (typeof b.enabled !== "boolean") throw new GovernanceError("invalid_enabled", "enabled must be a boolean")
  let credentialRef: string | null = null
  if (b.credentialRef != null && b.credentialRef !== "") {
    credentialRef = String(b.credentialRef).trim()
    if (!CREDENTIAL_REF_RE.test(credentialRef)) throw new GovernanceError("invalid_credential_ref", "credentialRef must be a vault reference, not a secret")
  }
  if (provider !== "platform" && provider !== "webrtc" && b.enabled && !credentialRef) {
    throw new GovernanceError("credential_required", `${provider} requires a credentialRef from the secrets vault`)
  }
  const hourlyLimit = limitOrNull(b.hourlyLimit, "hourlyLimit")
  const dailyLimit = limitOrNull(b.dailyLimit, "dailyLimit")
  if (hourlyLimit != null && dailyLimit != null && hourlyLimit > dailyLimit) {
    throw new GovernanceError("invalid_limit", "hourlyLimit cannot exceed dailyLimit")
  }
  const settings: Record<string, string | number | boolean> = {}
  const rawSettings = b.settings ?? {}
  if (typeof rawSettings !== "object" || Array.isArray(rawSettings)) throw new GovernanceError("invalid_settings", "settings must be an object")
  const entries = Object.entries(rawSettings as Record<string, unknown>)
  if (entries.length > 20) throw new GovernanceError("invalid_settings", "Too many settings")
  for (const [k, v] of entries) {
    if (!SETTING_KEY_RE.test(k)) throw new GovernanceError("invalid_settings", `Invalid setting key "${k}"`)
    if (SECRET_KEY_RE.test(k)) throw new GovernanceError("secret_in_settings", `Setting "${k}" looks like a secret; store it in the vault`)
    if (typeof v === "string") settings[k] = v.slice(0, 255)
    else if (typeof v === "number" && Number.isFinite(v)) settings[k] = v
    else if (typeof v === "boolean") settings[k] = v
    else throw new GovernanceError("invalid_settings", `Setting "${k}" must be a string, number or boolean`)
  }
  return { channel: b.channel, provider, enabled: b.enabled, credentialRef, hourlyLimit, dailyLimit, settings }
}

/** Canonical form of a recipient address per channel (for hashing/matching). */
export function normalizeAddress(channel: CommChannel, address: string): string {
  const raw = String(address ?? "").trim()
  if (!raw) throw new GovernanceError("invalid_address", "Address is required")
  if (channel === "email") {
    const v = raw.toLowerCase()
    if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new GovernanceError("invalid_address", "Invalid email address")
    return v
  }
  if (channel === "push") return raw.slice(0, 512)
  const digits = raw.replace(/[^\d]/g, "")
  if (digits.length < 6 || digits.length > 15) throw new GovernanceError("invalid_address", "Invalid phone number")
  return digits
}

/** Stable hash used for suppression lookup; the raw address is never indexed. */
export function addressHash(channel: CommChannel, address: string): string {
  return crypto.createHash("sha256").update(`${channel}:${normalizeAddress(channel, address)}`).digest("hex")
}

/** Masked display value for admin UIs (no full PII in lists / logs). */
export function maskAddress(channel: CommChannel, address: string): string {
  const v = normalizeAddress(channel, address)
  if (channel === "email") {
    const [user, domain] = v.split("@")
    return `${user.slice(0, 2)}***@${domain}`
  }
  if (channel === "push") return `${v.slice(0, 6)}…`
  return `***${v.slice(-4)}`
}

export type SendDecision =
  | { ok: true }
  | { ok: false; code: "provider_disabled" | "suppressed" | "rate_limited"; reason?: string; retryAt?: Date }

/**
 * Decide whether an outbound message may be dispatched.
 * - A disabled tenant provider blocks everything on that channel.
 * - Hard bounces and manual suppressions block everything (undeliverable).
 * - Complaints / opt-outs (consent withdrawn) block everything except
 *   mandatory security/compliance notices.
 * - Soft bounces only block once the threshold is reached.
 */
export function decideSend(input: {
  providerEnabled: boolean
  suppressions: { reason: SuppressionReason; count?: number }[]
  mandatory?: boolean
}): SendDecision {
  if (!input.providerEnabled) return { ok: false, code: "provider_disabled" }
  for (const s of input.suppressions) {
    if (s.reason === "hard_bounce" || s.reason === "manual") return { ok: false, code: "suppressed", reason: s.reason }
    if (s.reason === "soft_bounce" && (s.count ?? 1) >= SOFT_BOUNCE_THRESHOLD) return { ok: false, code: "suppressed", reason: s.reason }
    if (CONSENT_REASONS.includes(s.reason) && !input.mandatory) return { ok: false, code: "suppressed", reason: s.reason }
  }
  return { ok: true }
}

/** UTC start of the hour/day window a timestamp falls in. */
export function windowStart(kind: "hour" | "day", at: Date = new Date()): Date {
  const d = new Date(at.getTime())
  d.setUTCMinutes(0, 0, 0)
  if (kind === "day") d.setUTCHours(0)
  return d
}

export function nextWindow(kind: "hour" | "day", at: Date = new Date()): Date {
  const s = windowStart(kind, at)
  return new Date(s.getTime() + (kind === "hour" ? 3_600_000 : 86_400_000))
}

export function mysqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}

/** WhatsApp/SMS opt-out and opt-in keywords (case/whitespace insensitive). */
export function consentKeyword(text: string | null | undefined): "opt_out" | "opt_in" | null {
  const v = String(text ?? "").trim().toUpperCase()
  if (["STOP", "UNSUBSCRIBE", "STOPALL", "CANCEL", "OPT OUT", "OPTOUT"].includes(v)) return "opt_out"
  if (["START", "SUBSCRIBE", "UNSTOP", "OPT IN", "OPTIN"].includes(v)) return "opt_in"
  return null
}

/* ------------------------ email provider events ------------------------ */

export type EmailProviderEvent = {
  eventId: string
  type: "hard_bounce" | "soft_bounce" | "complaint" | "delivered"
  address: string
  providerMessageId: string | null
}

export const EMAIL_EVENT_PROVIDERS = ["ses", "sendgrid", "resend", "generic"] as const
export type EmailEventProvider = (typeof EMAIL_EVENT_PROVIDERS)[number]

function s(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

/**
 * Normalize provider bounce/complaint webhooks into one shape. Unknown event
 * types are dropped (never guessed). Each event carries a provider-unique id
 * used for duplicate-delivery protection.
 */
export function parseEmailEvents(provider: EmailEventProvider, body: unknown): EmailProviderEvent[] {
  const out: EmailProviderEvent[] = []
  const push = (e: EmailProviderEvent) => {
    if (!e.eventId || !e.address) return
    try {
      out.push({ ...e, address: normalizeAddress("email", e.address), eventId: e.eventId.slice(0, 190) })
    } catch {
      /* invalid address: ignore */
    }
  }
  if (provider === "ses") {
    const raw = body as Record<string, any>
    const msg = typeof raw?.Message === "string" ? safeJson(raw.Message) : raw
    const type = s(msg?.notificationType ?? msg?.eventType)
    const mid = s(msg?.mail?.messageId) || null
    const base = s(raw?.MessageId) || s(msg?.mail?.messageId)
    if (type === "Bounce") {
      const hard = s(msg?.bounce?.bounceType) === "Permanent"
      for (const r of msg?.bounce?.bouncedRecipients ?? []) push({ eventId: `${base}:${s(r?.emailAddress)}`, type: hard ? "hard_bounce" : "soft_bounce", address: s(r?.emailAddress), providerMessageId: mid })
    } else if (type === "Complaint") {
      for (const r of msg?.complaint?.complainedRecipients ?? []) push({ eventId: `${base}:${s(r?.emailAddress)}`, type: "complaint", address: s(r?.emailAddress), providerMessageId: mid })
    } else if (type === "Delivery") {
      for (const a of msg?.delivery?.recipients ?? []) push({ eventId: `${base}:${s(a)}`, type: "delivered", address: s(a), providerMessageId: mid })
    }
    return out
  }
  if (provider === "sendgrid") {
    for (const e of Array.isArray(body) ? body : []) {
      const ev = s(e?.event)
      const type = ev === "bounce" ? (s(e?.type) === "blocked" ? "soft_bounce" : "hard_bounce") : ev === "deferred" ? "soft_bounce" : ev === "spamreport" ? "complaint" : ev === "delivered" ? "delivered" : null
      if (type) push({ eventId: s(e?.sg_event_id), type, address: s(e?.email), providerMessageId: s(e?.sg_message_id).split(".")[0] || null })
    }
    return out
  }
  if (provider === "resend") {
    const e = body as Record<string, any>
    const t = s(e?.type)
    const type = t === "email.bounced" ? (s(e?.data?.bounce?.type) === "Transient" ? "soft_bounce" : "hard_bounce") : t === "email.complained" ? "complaint" : t === "email.delivered" ? "delivered" : null
    const to = Array.isArray(e?.data?.to) ? e.data.to : [e?.data?.to]
    if (type) for (const a of to) push({ eventId: `${s(e?.data?.email_id)}:${t}:${s(a)}`, type, address: s(a), providerMessageId: s(e?.data?.email_id) || null })
    return out
  }
  for (const e of Array.isArray((body as any)?.events) ? (body as any).events : []) {
    const type = s(e?.type)
    if (type === "hard_bounce" || type === "soft_bounce" || type === "complaint" || type === "delivered") {
      push({ eventId: s(e?.id), type, address: s(e?.email), providerMessageId: s(e?.messageId) || null })
    }
  }
  return out
}

function safeJson(v: string): any {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** Constant-time check of `sha256=<hex>` over `${timestamp}.${rawBody}`. */
export function verifyEventSignature(input: {
  secret: string | undefined
  rawBody: string
  timestamp: string | null
  signature: string | null
  now?: number
  toleranceSeconds?: number
}): boolean {
  if (!input.secret || !input.timestamp || !input.signature) return false
  const ts = Number(input.timestamp)
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return false
  const expected = "sha256=" + crypto.createHmac("sha256", input.secret).update(`${input.timestamp}.${input.rawBody}`).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
