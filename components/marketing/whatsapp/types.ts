/** Client-side mirrors of the WhatsApp platform API response shapes. */

export type HealthCheck = {
  id: string
  label: string
  status: "ok" | "warn" | "error" | "unknown"
  detail: string
}

export type ConnectionHealth = {
  connected: boolean
  overall: "healthy" | "degraded" | "down" | "disconnected"
  integration: {
    id: number
    wabaId: string
    phoneNumberId: string
    displayPhoneNumber: string | null
    verifiedName: string | null
    businessName: string | null
    qualityRating: string | null
    platformType: string | null
    coexistence: boolean
    connectedAt: string
  } | null
  webhookUrl: string
  checks: HealthCheck[]
  phone: {
    displayPhoneNumber: string | null
    verifiedName: string | null
    qualityRating: string | null
    platformType: string | null
    coexistence: boolean | null
  } | null
  webhook: {
    lastEventAt: string | null
    lastErrorAt: string | null
    lastError: string | null
    eventsLast24h: number
  }
  templates: { approved: number; total: number }
  checkedAt: string
}

export type WhatsAppCaps = {
  isAgent: boolean
  canViewAll: boolean
  canViewDepartment: boolean
  canSend: boolean
  canAssign: boolean
  canReassign: boolean
  canClose: boolean
  canSendTemplates: boolean
  canCreateCampaigns: boolean
  canViewAnalytics: boolean
  canManageContacts: boolean
  canManageAutomation: boolean
  canManagePlatform: boolean
}

export type StatusResponse = {
  health: ConnectionHealth
  caps: WhatsAppCaps
  role: "admin" | "employee"
}

export type Department = {
  id: number
  name: string
  slug: string
  description: string | null
  isActive: boolean
  managerUserId: number | null
  managerName: string | null
  routingMethod: string
  autoAssign: boolean
  keywords: string[]
  color: string | null
  sortOrder: number
  agentCount: number
  openConversations: number
}

export type AgentProfile = {
  userId: number
  name: string
  email: string
  role: "admin" | "employee"
  designation: string | null
  isAgent: boolean
  isAvailable: boolean
  departments: { id: number; name: string; role: "agent" | "manager" }[]
  caps: Record<string, boolean>
}

export type Campaign = {
  id: number
  name: string
  type: string
  departmentId: number | null
  audienceId: number | null
  audienceName: string | null
  templateName: string | null
  templateLanguage: string | null
  variables: string[]
  status: string
  totalRecipients: number
  sentCount: number
  deliveredCount: number
  readCount: number
  failedCount: number
  repliedCount: number
  createdByName: string | null
  scheduledAt: string | null
  createdAt: string
  lastError: string | null
}

export type Automation = {
  id: number
  name: string
  isActive: boolean
  triggerType: string
  triggerConfig: Record<string, unknown>
  actionType: string
  actionConfig: Record<string, unknown>
  departmentId: number | null
  departmentName: string | null
  priority: number
  runCount: number
  lastRunAt: string | null
  createdAt: string
}

export type Audience = {
  id: number
  name: string
  description: string | null
  createdAt: string
}

export type WhatsAppTemplate = {
  name: string
  status: string
  category?: string
  language: string
  components?: unknown[]
}

export type WhatsAppContact = {
  id: number
  phone: string
  name: string | null
  leadId: number | null
  createdAt: string | null
}

export type WhatsAppAnalytics = {
  totals: {
    contacts: number
    optedInContacts: number
    openConversations: number
    closedConversations: number
    unassigned: number
    unread: number
    inbound7d: number
    outbound7d: number
    campaigns: number
    activeAutomations: number
  }
  avgFirstResponseMinutes: number | null
  daily: { date: string; inbound: number; outbound: number }[]
  departments: { id: number; name: string; open: number; agents: number }[]
  agents: { userId: number; name: string; open: number; closed7d: number; sent7d: number }[]
  campaigns: {
    id: number
    name: string
    status: string
    total: number
    sent: number
    delivered: number
    read: number
    failed: number
    replied: number
  }[]
}
