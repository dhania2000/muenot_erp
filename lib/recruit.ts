// Client-safe constants and helpers shared by the Recruit module UI.
// No server-only imports here so it can be used from client components.

import { inr0 } from "@/lib/finance-calc"
import { rtFormatDate, rtFormatDateTime } from "@/lib/settings/runtime"
import { CANONICAL_STAGES, STAGE_LABELS as CANONICAL_STAGE_LABELS, type CanonicalStage } from "@/lib/recruitment-stages"

// Phase 11: the application pipeline speaks the one canonical stage vocabulary.
// StageKey and APPLICATION_STAGES are now thin re-exports of the shared system
// so the operational UI and the config-driven modules never diverge.
export type StageKey = CanonicalStage

export const APPLICATION_STAGES: { key: StageKey; label: string; tone: string }[] = CANONICAL_STAGES.map(
  ({ key, label, tone }) => ({ key, label, tone }),
)

export const STAGE_LABELS: Record<string, string> = CANONICAL_STAGE_LABELS

export const JOB_TYPES = [
  { value: "full_time", label: "Full Time" },
  { value: "part_time", label: "Part Time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
  { value: "freelance", label: "Freelance" },
  { value: "temporary", label: "Temporary" },
]

export const WORK_MODES = [
  { value: "on_site", label: "On-site" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
]

export const JOB_STATUSES = [
  { value: "open", label: "Open" },
  { value: "on_hold", label: "On Hold" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
]

export const INTERVIEW_MODES = [
  { value: "in_person", label: "In Person" },
  { value: "phone", label: "Phone" },
  { value: "video", label: "Video Call" },
]

export const INTERVIEW_STATUSES = [
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No Show" },
]

export const OFFER_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending Approval" },
  { value: "approved", label: "Approved" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
]

/**
 * Offer approval lifecycle (Phase 22). The offer's `status` column carries the
 * full lifecycle; each action is only valid from one of its `from` states and
 * moves the offer to `to`. Actions flagged `approval: true` (approve / reject /
 * send) require the `recruitment.approve_offers` permission — everything else
 * only needs `recruitment.manage_offers`.
 */
export type OfferAction =
  | "submit"
  | "approve"
  | "reject"
  | "send"
  | "accept"
  | "decline"
  | "expire"
  | "withdraw"
  | "reset"

export const OFFER_TRANSITIONS: Record<
  OfferAction,
  { from: string[]; to: string; label: string; approval?: boolean; destructive?: boolean }
> = {
  submit: { from: ["draft", "rejected", "withdrawn"], to: "pending_approval", label: "Submit for approval" },
  approve: { from: ["pending_approval"], to: "approved", label: "Approve", approval: true },
  reject: { from: ["pending_approval"], to: "rejected", label: "Reject", approval: true, destructive: true },
  send: { from: ["approved"], to: "sent", label: "Send to candidate", approval: true },
  accept: { from: ["sent"], to: "accepted", label: "Mark accepted" },
  decline: { from: ["sent"], to: "rejected", label: "Mark declined", destructive: true },
  expire: { from: ["approved", "sent"], to: "expired", label: "Mark expired" },
  withdraw: {
    from: ["draft", "pending_approval", "approved", "sent"],
    to: "withdrawn",
    label: "Withdraw offer",
    destructive: true,
  },
  reset: { from: ["pending_approval", "approved", "rejected", "expired", "withdrawn"], to: "draft", label: "Reset to draft" },
}

/** Actions currently allowed from a given offer status, in menu order. */
export function offerActionsFor(status: string | null | undefined): OfferAction[] {
  const current = status || "draft"
  return (Object.keys(OFFER_TRANSITIONS) as OfferAction[]).filter((a) =>
    OFFER_TRANSITIONS[a].from.includes(current),
  )
}

export const QUESTION_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Paragraph" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown" },
  { value: "radio", label: "Single choice" },
  { value: "checkbox", label: "Multiple choice" },
  { value: "file", label: "File URL" },
]

export const QUESTION_TYPES_WITH_OPTIONS = new Set(["select", "radio", "checkbox"])

export function labelFor(list: { value: string; label: string }[], value?: string | null) {
  return list.find((i) => i.value === value)?.label ?? value ?? "—"
}

export function formatMoney(amount?: number | string | null, currency = "INR") {
  if (amount === null || amount === undefined || amount === "") return "—"
  const n = Number(amount)
  if (Number.isNaN(n)) return "—"
  // For the default currency, honour the configured symbol/position/separators.
  // A caller-supplied non-default currency code still uses its ISO formatting.
  if (currency === "INR") return inr0(n)
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString("en-IN")}`
  }
}

export function salaryRange(from?: number | string | null, to?: number | string | null, currency = "INR") {
  const f = from === null || from === undefined || from === "" ? null : Number(from)
  const t = to === null || to === undefined || to === "" ? null : Number(to)
  if (!f && !t) return "Not disclosed"
  if (f && t) return `${formatMoney(f, currency)} – ${formatMoney(t, currency)}`
  return formatMoney((f ?? t) as number, currency)
}

export function safeParse<T>(value: any, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback
  if (typeof value === "object") return value as T
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

export function formatDate(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return rtFormatDate(d)
}

export function formatDateTime(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return rtFormatDateTime(d)
}

export type JobQuestion = {
  id?: number
  question: string
  type: string
  options: string[]
  required: boolean
  sort_order?: number
}
