/**
 * Spec28 (#127) — Support response & resolution SLA by customer plan. PURE.
 *
 * The customer's plan already carries a `support_level` entitlement
 * (lib/platform/entitlements.ts). That level × ticket priority selects an SLA
 * policy (response + resolution targets, in calendar minutes). Deadlines are
 * snapshotted onto the ticket at creation so a later plan change never
 * retroactively moves a promise already made.
 */
import { SUPPORT_LEVELS, type SupportLevel } from "@/lib/platform/entitlements"

export { SUPPORT_LEVELS, type SupportLevel }

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const TICKET_STATUSES = ["open", "in_progress", "waiting_customer", "resolved", "closed"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export type SlaTarget = { responseMinutes: number; resolutionMinutes: number }
export type SlaPolicyTable = Record<SupportLevel, Record<TicketPriority, SlaTarget>>

const H = 60
export const DEFAULT_SLA_POLICIES: SlaPolicyTable = {
  community: {
    low: { responseMinutes: 72 * H, resolutionMinutes: 15 * 24 * H },
    normal: { responseMinutes: 48 * H, resolutionMinutes: 10 * 24 * H },
    high: { responseMinutes: 24 * H, resolutionMinutes: 5 * 24 * H },
    urgent: { responseMinutes: 12 * H, resolutionMinutes: 3 * 24 * H },
  },
  email: {
    low: { responseMinutes: 24 * H, resolutionMinutes: 5 * 24 * H },
    normal: { responseMinutes: 8 * H, resolutionMinutes: 3 * 24 * H },
    high: { responseMinutes: 4 * H, resolutionMinutes: 24 * H },
    urgent: { responseMinutes: 2 * H, resolutionMinutes: 12 * H },
  },
  priority: {
    low: { responseMinutes: 8 * H, resolutionMinutes: 2 * 24 * H },
    normal: { responseMinutes: 4 * H, resolutionMinutes: 24 * H },
    high: { responseMinutes: 1 * H, resolutionMinutes: 8 * H },
    urgent: { responseMinutes: 30, resolutionMinutes: 4 * H },
  },
  dedicated: {
    low: { responseMinutes: 4 * H, resolutionMinutes: 24 * H },
    normal: { responseMinutes: 1 * H, resolutionMinutes: 8 * H },
    high: { responseMinutes: 30, resolutionMinutes: 4 * H },
    urgent: { responseMinutes: 15, resolutionMinutes: 2 * H },
  },
}

export const MAX_SLA_MINUTES = 60 * 24 * 60 // 60 days

export function toPriority(value: unknown): TicketPriority | null {
  return (TICKET_PRIORITIES as readonly string[]).includes(String(value)) ? (value as TicketPriority) : null
}
export function toSupportLevel(value: unknown): SupportLevel {
  return (SUPPORT_LEVELS as readonly string[]).includes(String(value)) ? (value as SupportLevel) : "community"
}
export function toTicketStatus(value: unknown): TicketStatus | null {
  return (TICKET_STATUSES as readonly string[]).includes(String(value)) ? (value as TicketStatus) : null
}

export function validateSlaTarget(raw: Record<string, unknown>): { ok: true; value: SlaTarget } | { ok: false; error: string } {
  const r = Number(raw.responseMinutes)
  const s = Number(raw.resolutionMinutes)
  if (!Number.isInteger(r) || r < 5 || r > MAX_SLA_MINUTES) return { ok: false, error: "responseMinutes must be an integer between 5 and 86400" }
  if (!Number.isInteger(s) || s < 5 || s > MAX_SLA_MINUTES) return { ok: false, error: "resolutionMinutes must be an integer between 5 and 86400" }
  if (s < r) return { ok: false, error: "resolution target cannot be shorter than response target" }
  return { ok: true, value: { responseMinutes: r, resolutionMinutes: s } }
}

export function computeDueDates(createdAt: Date, target: SlaTarget): { responseDueAt: Date; resolutionDueAt: Date } {
  return {
    responseDueAt: new Date(createdAt.getTime() + target.responseMinutes * 60_000),
    resolutionDueAt: new Date(createdAt.getTime() + target.resolutionMinutes * 60_000),
  }
}

export type SlaClockState = "met" | "on_track" | "at_risk" | "breached"

export type SlaSubject = {
  createdAt: string
  responseDueAt: string
  resolutionDueAt: string
  firstResponseAt: string | null
  resolvedAt: string | null
}

export type SlaEvaluation = {
  response: SlaClockState
  resolution: SlaClockState
  responseRemainingMinutes: number | null
  resolutionRemainingMinutes: number | null
}

/** Share of a window remaining under which a running clock is "at risk". */
export const AT_RISK_FRACTION = 0.2

function parse(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(value) ? `${value.replace(" ", "T")}Z` : value)
}

function clock(created: number, due: number, doneAt: string | null, now: number): { state: SlaClockState; remaining: number | null } {
  if (doneAt) return { state: parse(doneAt) <= due ? "met" : "breached", remaining: null }
  const remaining = Math.floor((due - now) / 60_000)
  if (now > due) return { state: "breached", remaining }
  const window = Math.max(1, due - created)
  return { state: (due - now) / window <= AT_RISK_FRACTION ? "at_risk" : "on_track", remaining }
}

export function evaluateSla(t: SlaSubject, now: Date = new Date()): SlaEvaluation {
  const created = parse(t.createdAt)
  const r = clock(created, parse(t.responseDueAt), t.firstResponseAt, now.getTime())
  const s = clock(created, parse(t.resolutionDueAt), t.resolvedAt, now.getTime())
  return { response: r.state, resolution: s.state, responseRemainingMinutes: r.remaining, resolutionRemainingMinutes: s.remaining }
}

export type TicketInput = { subject: string; description: string; priority: TicketPriority }

export function validateTicketInput(raw: Record<string, unknown>): { ok: true; value: TicketInput } | { ok: false; error: string } {
  const subject = typeof raw.subject === "string" ? raw.subject.trim() : ""
  if (subject.length < 3 || subject.length > 200) return { ok: false, error: "subject must be 3-200 characters" }
  const description = typeof raw.description === "string" ? raw.description.trim() : ""
  if (description.length > 5000) return { ok: false, error: "description must be at most 5000 characters" }
  const priority = raw.priority == null || raw.priority === "" ? "normal" : toPriority(raw.priority)
  if (!priority) return { ok: false, error: "priority must be low, normal, high or urgent" }
  return { ok: true, value: { subject, description, priority } }
}

/** Idempotency keys: opaque, bounded, header-safe. */
export function normalizeIdempotencyKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.trim()
  return /^[A-Za-z0-9_.:-]{8,100}$/.test(key) ? key : null
}

export function toDbDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}
