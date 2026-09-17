import { Badge } from "@/components/ui/badge"
import {
  FileText, ClipboardList, ShieldCheck, HelpCircle, BookOpen, LayoutTemplate,
  GraduationCap, Megaphone, Folder, Building2, Settings, Star, Pin, AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Shared types (mirror the API payloads in app/api/knowledge-base/*)
// ---------------------------------------------------------------------------
export type ContentType =
  | "article" | "sop" | "policy" | "faq" | "guide" | "template" | "training" | "announcement"
export type Status =
  | "draft" | "in_review" | "scheduled" | "published" | "expired" | "archived" | "rejected"
export type AudienceType = "all" | "department" | "designation" | "employees" | "management" | "admin"
export type ToType = "employees" | "clients"

export type ArticleRow = {
  id: number
  article_code: string | null
  heading: string
  summary: string | null
  category_id: number | null
  category_name: string | null
  subcategory: string | null
  tags: string | null
  content_type: ContentType
  to_type: ToType
  status: Status
  version: number
  audience_type: AudienceType
  department: string | null
  author_id: number | null
  author_name: string | null
  owner_id: number | null
  owner_name: string | null
  pinned: number
  important: number
  acknowledgement_required: number
  view_count: number
  helpful_count: number
  not_helpful_count: number
  publish_date: string | null
  published_at: string | null
  review_date: string | null
  expiry_date: string | null
  effective_date: string | null
  created_at: string
  updated_at: string
  is_favorite: number
  is_read: number
  is_acknowledged: number
  attachment_count: number
}

export type Category = { id: number; name: string; active?: boolean; sort_order?: number; article_count?: number }
export type MetaEmployee = { id: number; name: string; department: string | null; designation: string | null; active: boolean }
export type MetaResponse = {
  categories: Category[]
  departments: string[]
  designations: string[]
  employees: MetaEmployee[]
  authors: { id: number; name: string }[]
  articles: { id: number; code: string | null; heading: string; content_type: ContentType }[]
  contentTypes: { value: ContentType; label: string }[]
}

export type ListResponse = {
  articles: ArticleRow[]
  categories: Category[]
  total: number
  page: number
  pageSize: number
  canManage: boolean
  contentTypes: { value: ContentType; label: string }[]
}

export type Attachment = { id: number; file_name: string; file_type: string | null; file_size: number }
export type RelatedArticle = { id: number; article_code: string | null; heading: string; content_type: ContentType; status: Status }
export type ErpLink = { source_module: string; source_record_id: string; label: string | null }
export type Version = {
  version: number; heading: string; status: string | null; change_summary: string | null
  edited_by_name: string | null; edited_at: string
}
export type Analytics = {
  totalRecipients: number; read: number; unread: number; acknowledged: number; pending: number
  emailSent: number; emailFailed: number; inAppSent: number; helpful: number; notHelpful: number
}
export type RecipientStatus = {
  id: number; employee_name: string; department: string | null; designation: string | null
  read_at: string | null; acknowledged_at: string | null
}
export type Feedback = { id: number; helpful: number; comment: string | null; created_at: string }

export type ArticleDetail = {
  article: ArticleRow & { content: string; description: string; tags: string[]; reject_reason: string | null; review_note: string | null; reviewer_name: string | null; keep_pinned_after_expiry: number; notify_in_app: number; notify_email: number; source_module: string | null; source_record_id: string | null }
  attachments: Attachment[]
  related: RelatedArticle[]
  erpLinks: ErpLink[]
  versions: Version[]
  analytics: Analytics | null
  recipientStatus: RecipientStatus[]
  feedback: Feedback[]
  canManage: boolean
  canApprove: boolean
  userState: { isRead: boolean; isAck: boolean; isFavorite: boolean }
}

// ---------------------------------------------------------------------------
// Content-type + status metadata
// ---------------------------------------------------------------------------
export const CONTENT_TYPE_META: Record<ContentType, { label: string; icon: typeof FileText }> = {
  article: { label: "Article", icon: FileText },
  sop: { label: "SOP", icon: ClipboardList },
  policy: { label: "Policy", icon: ShieldCheck },
  faq: { label: "FAQ", icon: HelpCircle },
  guide: { label: "Guide", icon: BookOpen },
  template: { label: "Template", icon: LayoutTemplate },
  training: { label: "Training", icon: GraduationCap },
  announcement: { label: "Announcement", icon: Megaphone },
}

export const STATUS_META: Record<Status, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  in_review: { label: "In Review", className: "bg-amber-500/15 text-amber-500" },
  scheduled: { label: "Scheduled", className: "bg-sky-500/15 text-sky-500" },
  published: { label: "Published", className: "bg-emerald-500/15 text-emerald-500" },
  expired: { label: "Expired", className: "bg-orange-500/15 text-orange-500" },
  archived: { label: "Archived", className: "bg-zinc-500/15 text-zinc-400" },
  rejected: { label: "Rejected", className: "bg-destructive/15 text-destructive" },
}

export const AUDIENCE_LABELS: Record<AudienceType, string> = {
  all: "All Employees",
  department: "Department",
  designation: "Designation",
  employees: "Selected Employees",
  management: "Management",
  admin: "Admin",
}

export type Section = {
  key: string
  label: string
  icon: typeof FileText
  contentType?: ContentType
  kind: "list" | "categories" | "departments" | "settings"
}

export const SECTIONS: Section[] = [
  { key: "articles", label: "Articles", icon: FileText, kind: "list" },
  { key: "categories", label: "Categories", icon: Folder, kind: "categories" },
  { key: "departments", label: "Departments", icon: Building2, kind: "departments" },
  { key: "sop", label: "SOPs", icon: ClipboardList, contentType: "sop", kind: "list" },
  { key: "policy", label: "Policies", icon: ShieldCheck, contentType: "policy", kind: "list" },
  { key: "faq", label: "FAQs", icon: HelpCircle, contentType: "faq", kind: "list" },
  { key: "guide", label: "Guides", icon: BookOpen, contentType: "guide", kind: "list" },
  { key: "template", label: "Templates", icon: LayoutTemplate, contentType: "template", kind: "list" },
  { key: "training", label: "Training", icon: GraduationCap, contentType: "training", kind: "list" },
  { key: "announcement", label: "Announcements", icon: Megaphone, contentType: "announcement", kind: "list" },
  { key: "settings", label: "Settings", icon: Settings, kind: "settings" },
]

export const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Recently Updated" },
  { value: "most_viewed", label: "Most Viewed" },
  { value: "most_helpful", label: "Most Helpful" },
  { value: "az", label: "A – Z" },
]

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
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

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`
}

// ---------------------------------------------------------------------------
// Presentational badges
// ---------------------------------------------------------------------------
export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 text-xs font-medium",
        meta.className,
        className,
      )}
    >
      {meta.label}
    </span>
  )
}

export function TypeBadge({ type }: { type: ContentType }) {
  const meta = CONTENT_TYPE_META[type] ?? CONTENT_TYPE_META.article
  const Icon = meta.icon
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Icon className="size-3" /> {meta.label}
    </Badge>
  )
}

export function FlagIcons({ pinned, important }: { pinned?: number | boolean; important?: number | boolean }) {
  if (!pinned && !important) return null
  return (
    <span className="inline-flex items-center gap-1">
      {pinned ? <Pin className="size-3.5 text-primary" aria-label="Pinned" /> : null}
      {important ? <AlertTriangle className="size-3.5 text-amber-500" aria-label="Important" /> : null}
    </span>
  )
}

export function FavoriteStar({ active }: { active: boolean }) {
  return <Star className={cn("size-3.5", active ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
}
