import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PlannerStatus, PlannerPriority } from "@/lib/marketing/planner-constants"

// ---------------------------------------------------------------------------
// Types shared across the Planner UI
// ---------------------------------------------------------------------------

export type PlannerItem = {
  id: number
  item_code: string
  title: string
  description?: string | null
  status: PlannerStatus
  priority: PlannerPriority
  channel: string
  content_type: string
  start_date?: string | null
  due_date?: string | null
  publish_at?: string | null
  published_at?: string | null
  scheduled_at?: string | null
  campaign?: string | null
  campaign_id?: number | null
  campaign_name?: string | null
  journey_id?: number | null
  journey_name?: string | null
  segment_id?: number | null
  segment_name?: string | null
  owner_id?: number | null
  owner_name?: string | null
  assignee_id?: number | null
  assignee_name?: string | null
  email_template_id?: number | null
  email_template_name?: string | null
  whatsapp_template_name?: string | null
  brief?: any
  target_audience?: any
  estimated_budget?: number | null
  actual_spend?: number | null
  budget_variance?: number | null
  over_budget?: boolean
  tags?: string[]
  color?: string | null
  related_type?: string | null
  related_id?: number | null
  recurrence?: any
  review_status?: string | null
  row_version: number
  board_column: string | null
  is_overdue?: boolean
  created_at?: string
  updated_at?: string
  // Detail-only
  assignees?: Assignee[]
  contributors?: Assignee[]
  dependencies?: DependencyRef[]
  dependents?: DependencyRef[]
  assets?: PlannerAsset[]
}

export type Assignee = {
  id: number
  user_id: number
  role: string
  name?: string
  email?: string
  assigned_at?: string
}

export type DependencyRef = {
  id: number
  item_code: string
  title: string
  status: PlannerStatus
}

export type PlannerAsset = {
  id: number
  label: string
  url?: string | null
  kind?: string | null
  library_asset_id?: string | null
  created_at?: string
}

export type Lookups = {
  employees: { id: number; name: string; email?: string }[]
  campaigns: { id: number; name: string; status?: string }[]
  journeys: { id: number; name: string }[]
  segments: { id: number; name: string }[]
  emailTemplates: { id: number; name: string; subject?: string }[]
  whatsappTemplates: { name: string; language: string; status: string }[]
  whatsappConnected: boolean
  emailConfigured: boolean
  channels: string[]
  contentTypes: string[]
}

export type ListResponse = {
  items: PlannerItem[]
  total: number
  summary: { total: number; byStatus: Record<string, number>; overdue: number }
}

// ---------------------------------------------------------------------------
// Status / priority visuals
// ---------------------------------------------------------------------------

/** Tailwind color chip class per status, grouped by workflow stage. */
export const STATUS_STYLES: Record<string, string> = {
  Backlog: "bg-muted text-muted-foreground",
  Draft: "bg-muted text-muted-foreground",
  Planned: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  Assigned: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "In Progress": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Review: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  Blocked: "bg-destructive/15 text-destructive",
  Scheduled: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  Ready: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  Published: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Cancelled: "bg-muted text-muted-foreground line-through",
  Archived: "bg-muted text-muted-foreground",
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {status}
    </span>
  )
}

export const PRIORITY_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Urgent: "destructive",
  High: "default",
  Normal: "secondary",
  Low: "outline",
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge variant={PRIORITY_VARIANT[priority] ?? "outline"}>{priority}</Badge>
}

export const REVIEW_STYLES: Record<string, string> = {
  Pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Rejected: "bg-destructive/15 text-destructive",
  "Changes Requested": "bg-purple-500/15 text-purple-600 dark:text-purple-400",
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function fmtDate(value?: string | null): string {
  if (!value) return "—"
  const d = new Date(String(value).length <= 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function fmtRelative(value?: string | null): string {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (Math.abs(mins) < 60) return `${mins <= 0 ? "in " : ""}${Math.abs(mins)}m${mins > 0 ? " ago" : ""}`
  const hrs = Math.round(mins / 60)
  if (Math.abs(hrs) < 24) return `${hrs <= 0 ? "in " : ""}${Math.abs(hrs)}h${hrs > 0 ? " ago" : ""}`
  const days = Math.round(hrs / 24)
  return `${days <= 0 ? "in " : ""}${Math.abs(days)}d${days > 0 ? " ago" : ""}`
}

/** Convert a DB date to a value usable by <input type="date">. */
export function toDateInput(value?: string | null): string {
  if (!value) return ""
  return String(value).slice(0, 10)
}

/** Convert a DB datetime to a value usable by <input type="datetime-local">. */
export function toDateTimeLocal(value?: string | null): string {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60000)
  return local.toISOString().slice(0, 16)
}

export function fmtMoney(value?: number | null): string {
  if (value == null) return "—"
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    Number(value),
  )
}

export async function plannerFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err: any = new Error(json?.error || "Request failed")
    err.code = json?.code
    err.status = res.status
    throw err
  }
  return json
}
