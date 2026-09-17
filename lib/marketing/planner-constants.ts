// Shared, client-safe constants for the Marketing Planner.
// Imported by both server (planner-db) and client components — keep this file
// free of any server-only imports (no `lib/db`, no `next/*`).

export const PLANNER_STATUSES = [
  "Backlog",
  "Draft",
  "Planned",
  "Assigned",
  "In Progress",
  "Review",
  "Blocked",
  "Scheduled",
  "Ready",
  "Published",
  "Completed",
  "Cancelled",
  "Archived",
] as const

export type PlannerStatus = (typeof PLANNER_STATUSES)[number]

export const PLANNER_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const
export type PlannerPriority = (typeof PLANNER_PRIORITIES)[number]

export const PLANNER_REVIEW_STATUSES = [
  "None",
  "Pending",
  "Approved",
  "Rejected",
  "Changes Requested",
] as const
export type PlannerReviewStatus = (typeof PLANNER_REVIEW_STATUSES)[number]

// The four canonical Kanban columns the original UI shipped with. Every status
// maps to exactly one column so the board keeps working as the workflow grows.
export const BOARD_COLUMNS = ["Backlog", "Planned", "In Progress", "Published"] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

const STATUS_TO_COLUMN: Record<PlannerStatus, BoardColumn | null> = {
  Backlog: "Backlog",
  Draft: "Backlog",
  Planned: "Planned",
  Assigned: "Planned",
  Scheduled: "Planned",
  Ready: "Planned",
  "In Progress": "In Progress",
  Review: "In Progress",
  Blocked: "In Progress",
  Published: "Published",
  Completed: "Published",
  // Terminal / off-board states are not shown on the Kanban board.
  Cancelled: null,
  Archived: null,
}

// Dropping a card into a column resolves to this canonical status.
export const COLUMN_DEFAULT_STATUS: Record<BoardColumn, PlannerStatus> = {
  Backlog: "Backlog",
  Planned: "Planned",
  "In Progress": "In Progress",
  Published: "Published",
}

export function boardColumnFor(status: string): BoardColumn | null {
  return STATUS_TO_COLUMN[status as PlannerStatus] ?? null
}

// Configurable content types (Phase 3). The server persists whatever string is
// chosen; this is the suggested, non-exhaustive picklist.
export const CONTENT_TYPES = [
  "Social Post",
  "Blog",
  "Article",
  "Video",
  "Image",
  "Newsletter",
  "Email",
  "WhatsApp",
  "Advertisement",
  "Landing Page",
  "Website Content",
  "Case Study",
  "Whitepaper",
  "Webinar",
  "Event",
  "Press Release",
  "Podcast",
  "Other",
] as const

// Channels (Phase 4). The lookups endpoint narrows this to channels that are
// actually configured (e.g. Email/WhatsApp only when integrations exist).
export const CHANNELS = [
  "Website",
  "Blog",
  "LinkedIn",
  "Facebook",
  "Instagram",
  "YouTube",
  "X/Twitter",
  "Email",
  "WhatsApp",
  "Google Ads",
  "Meta Ads",
  "Other",
] as const

// Allowed status transitions (Phase 21 / 34). Kept permissive enough to support
// the Idea -> Backlog -> Plan -> Assign -> In Progress -> Review -> Schedule ->
// Publish flow while blocking nonsensical jumps. `Published` is only reachable
// through the explicit publish action (Phase 88), never by drag alone.
export const ALLOWED_TRANSITIONS: Record<PlannerStatus, PlannerStatus[]> = {
  Backlog: ["Draft", "Planned", "Assigned", "Cancelled", "Archived"],
  Draft: ["Backlog", "Planned", "Assigned", "Cancelled", "Archived"],
  Planned: ["Backlog", "Assigned", "In Progress", "Blocked", "Scheduled", "Cancelled", "Archived"],
  Assigned: ["Planned", "In Progress", "Blocked", "Cancelled", "Archived"],
  "In Progress": ["Planned", "Review", "Blocked", "Scheduled", "Completed", "Cancelled", "Archived"],
  Review: ["In Progress", "Scheduled", "Blocked", "Completed", "Cancelled", "Archived"],
  Blocked: ["Planned", "In Progress", "Review", "Cancelled", "Archived"],
  Scheduled: ["In Progress", "Review", "Ready", "Published", "Blocked", "Cancelled", "Archived"],
  Ready: ["Scheduled", "Published", "Blocked", "Cancelled", "Archived"],
  Published: ["Completed", "Archived"],
  Completed: ["Archived"],
  Cancelled: ["Backlog", "Archived"],
  Archived: ["Backlog"],
}

export function canTransition(from: string, to: string): boolean {
  if (from === to) return true
  const allowed = ALLOWED_TRANSITIONS[from as PlannerStatus]
  return Array.isArray(allowed) && allowed.includes(to as PlannerStatus)
}

export const PRIORITY_RANK: Record<PlannerPriority, number> = {
  Urgent: 4,
  High: 3,
  Normal: 2,
  Low: 1,
}

// Statuses that count as "open work" for overdue / reminder logic.
export const OPEN_STATUSES: PlannerStatus[] = [
  "Backlog",
  "Draft",
  "Planned",
  "Assigned",
  "In Progress",
  "Review",
  "Blocked",
  "Scheduled",
  "Ready",
]

// Statuses that are considered "done" and should never be flagged overdue.
export const CLOSED_STATUSES: PlannerStatus[] = ["Published", "Completed", "Cancelled", "Archived"]
