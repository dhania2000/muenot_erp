export type ConversationType = "direct" | "group" | "department" | "management"

export type Conversation = {
  id: number
  type: ConversationType
  title: string
  name: string | null
  subject: string | null
  description: string | null
  photo_url: string | null
  department: string | null
  peer_id: number | null
  peer_name: string | null
  my_role: "member" | "admin"
  is_pinned: number
  is_muted: number
  is_archived: number
  unread: number
  last_message: string | null
  last_sender: string | null
  last_message_time: string | null
  last_message_type: string | null
  last_importance: string | null
  last_deleted: string | null
}

export type Participant = {
  user_id: number
  name: string
  email: string
  role: "member" | "admin"
  user_role: "admin" | "employee"
  department: string | null
  designation: string | null
  last_read_at: string | null
  active: boolean
}

export type Attachment = {
  id: number
  file_name: string
  file_type: string | null
  file_size: number | null
  url: string
}

export type Message = {
  id: number
  body: string | null
  deleted: boolean
  sender_id: number
  sender_name: string
  sender_role: "admin" | "employee"
  created_at: string
  edited_at: string | null
  message_type: "text" | "announcement" | "system"
  importance: "normal" | "important" | "urgent"
  source_module: string | null
  source_record_id: string | null
  source_label: string | null
  reply_to_id: number | null
  reply: { id: number; body: string | null; sender_name: string | null } | null
  attachments: Attachment[]
  mine: boolean
}

export type Recipient = {
  id: number
  name: string
  email: string
  role: "admin" | "employee"
  department: string | null
  designation: string | null
}

export type ConversationDetail = {
  conversation: {
    id: number
    type: ConversationType
    title: string
    name: string | null
    description: string | null
    photo_url: string | null
    department: string | null
    status: string
    created_by: number
  }
  myRole: "member" | "admin"
  isMuted: boolean
  isPinned: boolean
  isArchived: boolean
  notifSetting: "all" | "mentions" | "none"
  participants: Participant[]
  messages: Message[]
  hasMore: boolean
}

export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "Request failed")
  return data as T
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export function formatTime(iso: string | null) {
  if (!iso) return ""
  const d = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return "Yesterday"
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function formatBytes(n: number | null) {
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
