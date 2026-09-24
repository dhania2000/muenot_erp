export type TaskMeta = {
  users: { id: number; name: string; email: string }[]
  teams: { id: number; name: string }[]
  statuses: string[]
  priorities: string[]
  types: string[]
  recurrences: string[]
}

export type TaskListItem = {
  id: number
  title: string
  description: string | null
  task_type: string
  status: string
  priority: string
  assignee_id: number | null
  assignee_name: string | null
  team_id: number | null
  team_name: string | null
  due_date: string | null
  start_date: string | null
  progress: number
  recurrence: string
  approval_required: number
  approval_status: string
  blocked: boolean
}

export const PRIORITY_TONE: Record<string, string> = {
  Low: "border-transparent bg-muted text-muted-foreground",
  Medium: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
  High: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300",
  Urgent: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
}

export const STATUS_TONE: Record<string, string> = {
  "To Do": "border-transparent bg-muted text-muted-foreground",
  "In Progress": "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
  Blocked: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  "In Review": "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300",
  Done: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  Cancelled: "border-transparent bg-muted text-muted-foreground line-through",
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function isOverdue(due: string | null | undefined, status: string): boolean {
  if (!due || status === "Done" || status === "Cancelled") return false
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

/** Normalize a date value into the yyyy-mm-dd form an <input type="date"> expects. */
export function toDateInput(value: string | null | undefined): string {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value.slice(0, 10) : ""
  return d.toISOString().slice(0, 10)
}
