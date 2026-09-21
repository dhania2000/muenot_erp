import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { AlertTriangle, Flame, Pin } from "lucide-react"

export type Priority = "normal" | "important" | "urgent"
export type Status = "draft" | "scheduled" | "published" | "expired" | "archived" | "cancelled"
export type AudienceType = "all" | "department" | "designation" | "location" | "employment_type" | "employees"

export type AudienceConfig = {
  departments?: string[]
  designations?: string[]
  locations?: string[]
  employmentTypes?: string[]
  employeeIds?: number[]
}

export type ManageNotice = {
  id: number
  notice_code: string | null
  heading: string
  description: string
  category: string
  priority: Priority
  status: Status
  to_type: "employees" | "clients"
  audience_type: AudienceType
  audience_config: AudienceConfig
  department: string | null
  acknowledgement_required: boolean
  notify_in_app: boolean
  notify_email: boolean
  pinned: boolean
  start_date: string | null
  end_date: string | null
  publish_date: string | null
  published_at: string | null
  effective_date: string | null
  review_date: string | null
  version: number
  created_by_name: string | null
  created_at: string
  recipient_count: number
  read_count: number
  ack_count: number
}

export type FeedNotice = {
  id: number
  notice_code: string | null
  heading: string
  description: string
  category: string
  priority: Priority
  status: Status
  pinned: boolean
  acknowledgement_required: boolean
  is_read: boolean
  is_acknowledged: boolean
  published_at: string | null
  end_date: string | null
  created_by_name: string | null
  created_at: string
}

export type Meta = {
  categories: string[]
  departments: string[]
  designations: string[]
  locations: string[]
  employmentTypes: string[]
  employees: { id: number; name: string; department: string | null; designation: string | null; active: boolean }[]
}

export const STATUS_LABELS: Record<Status, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  expired: "Expired",
  archived: "Archived",
  cancelled: "Cancelled",
}

export const AUDIENCE_LABELS: Record<AudienceType, string> = {
  all: "All Employees",
  department: "Department",
  designation: "Designation",
  location: "Location",
  employment_type: "Employment Type",
  employees: "Selected Employees",
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—"
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    draft: "bg-muted text-muted-foreground",
    scheduled: "bg-blue-500/10 text-blue-500 dark:text-blue-400",
    published: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    expired: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    archived: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
    cancelled: "bg-destructive/10 text-destructive",
  }
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", styles[status])}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "urgent") {
    return (
      <Badge className="gap-1 bg-destructive/10 text-destructive">
        <Flame className="size-3" /> Urgent
      </Badge>
    )
  }
  if (priority === "important") {
    return (
      <Badge className="gap-1 bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3" /> Important
      </Badge>
    )
  }
  return <Badge variant="secondary" className="font-normal">Normal</Badge>
}

export function PinIcon({ className }: { className?: string }) {
  return <Pin className={cn("size-3.5", className)} />
}

/** Human-readable audience summary from type + config. */
export function audienceSummary(
  toType: "employees" | "clients",
  type: AudienceType,
  cfg: AudienceConfig,
  employees?: Meta["employees"],
): string {
  if (toType === "clients") return "All Clients"
  switch (type) {
    case "all":
      return "All Employees"
    case "department":
      return cfg.departments?.length ? cfg.departments.join(", ") : "Department"
    case "designation":
      return cfg.designations?.length ? cfg.designations.join(", ") : "Designation"
    case "location":
      return cfg.locations?.length ? cfg.locations.join(", ") : "Location"
    case "employment_type":
      return cfg.employmentTypes?.length ? cfg.employmentTypes.join(", ") : "Employment Type"
    case "employees": {
      const n = cfg.employeeIds?.length ?? 0
      if (!n) return "Selected Employees"
      if (employees) {
        const names = cfg.employeeIds!
          .map((id) => employees.find((e) => e.id === id)?.name)
          .filter(Boolean)
        if (names.length) return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")
      }
      return `${n} employee${n === 1 ? "" : "s"}`
    }
    default:
      return "All Employees"
  }
}
