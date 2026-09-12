/**
 * Shared WhatsApp platform configuration + granular permission catalog.
 *
 * Free of server-only imports so both the API layer and (the permission
 * catalog / labels part of) the UI can use it. The URL helpers read
 * environment variables that only exist server-side, but reading a missing
 * env var on the client simply falls back to the hardcoded production URL.
 */

/**
 * Production public base URL for building the Meta webhook callback and any
 * public links (media, campaign click-throughs).
 *
 * The number is served from https://erp.muenot.co.in in production, so that is
 * the hardcoded default — it is NEVER 0.0.0.0:3000. An administrator can still
 * override it (e.g. for a staging host) via WHATSAPP_PUBLIC_URL, falling back
 * to the app-wide APP_URL / NEXT_PUBLIC_APP_URL if those are set.
 */
export const DEFAULT_PUBLIC_BASE_URL = "https://erp.muenot.co.in"

export function getPublicBaseUrl(): string {
  const fromEnv =
    process.env.WHATSAPP_PUBLIC_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    ""
  const raw = fromEnv || DEFAULT_PUBLIC_BASE_URL
  // Normalise: strip trailing slash, force https, never allow a 0.0.0.0/local host.
  let url = raw.replace(/\/+$/, "")
  if (/^https?:\/\/(0\.0\.0\.0|localhost|127\.0\.0\.1)(:\d+)?/i.test(url)) {
    url = DEFAULT_PUBLIC_BASE_URL
  }
  if (url.startsWith("http://")) url = url.replace(/^http:\/\//, "https://")
  if (!/^https:\/\//i.test(url)) url = `https://${url}`
  return url
}

/** The exact webhook callback URL to configure in the Meta app dashboard. */
export function getWebhookUrl(): string {
  return `${getPublicBaseUrl()}/api/marketing/whatsapp/webhook`
}

/* ------------------------------------------------------------------ */
/* Granular WhatsApp permissions (spec §44)                            */
/* ------------------------------------------------------------------ */

export const WHATSAPP_PERMISSIONS = [
  "whatsapp.view",
  "whatsapp.send",
  "whatsapp.assign",
  "whatsapp.transfer",
  "whatsapp.manage_agents",
  "whatsapp.manage_departments",
  "whatsapp.manage_templates",
  "whatsapp.manage_campaigns",
  "whatsapp.launch_campaigns",
  "whatsapp.view_analytics",
  "whatsapp.manage_settings",
] as const

export type WhatsAppPermission = (typeof WHATSAPP_PERMISSIONS)[number]

export const WHATSAPP_PERMISSION_LABEL: Record<WhatsAppPermission, string> = {
  "whatsapp.view": "View conversations",
  "whatsapp.send": "Send messages",
  "whatsapp.assign": "Assign chats",
  "whatsapp.transfer": "Transfer / reassign chats",
  "whatsapp.manage_agents": "Manage agents",
  "whatsapp.manage_departments": "Manage departments",
  "whatsapp.manage_templates": "Manage templates",
  "whatsapp.manage_campaigns": "Create campaigns",
  "whatsapp.launch_campaigns": "Launch campaigns",
  "whatsapp.view_analytics": "View analytics",
  "whatsapp.manage_settings": "Manage settings",
}

/* ------------------------------------------------------------------ */
/* Routing methods (spec §12)                                          */
/* ------------------------------------------------------------------ */

export const ROUTING_METHODS = [
  "manual",
  "round_robin",
  "least_active",
  "least_assigned",
] as const
export type RoutingMethod = (typeof ROUTING_METHODS)[number]

export const ROUTING_METHOD_LABEL: Record<RoutingMethod, string> = {
  manual: "Manual (no auto-assign)",
  round_robin: "Round robin",
  least_active: "Least active agent",
  least_assigned: "Fewest open chats",
}

export function isRoutingMethod(v: unknown): v is RoutingMethod {
  return typeof v === "string" && (ROUTING_METHODS as readonly string[]).includes(v)
}

/* ------------------------------------------------------------------ */
/* Campaign + automation vocabularies                                  */
/* ------------------------------------------------------------------ */

export const CAMPAIGN_TYPES = [
  "promotional",
  "marketing",
  "utility",
  "retargeting",
  "announcement",
  "offer",
  "festival",
  "product_launch",
  "lead_follow_up",
  "reactivation",
] as const
export type CampaignType = (typeof CAMPAIGN_TYPES)[number]

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export const AUTOMATION_TRIGGERS = [
  "welcome",
  "keyword",
  "new_conversation",
  "no_reply",
  "customer_requests_human",
] as const
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number]

export const AUTOMATION_TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  welcome: "First message from a new contact",
  keyword: "Inbound message contains keyword",
  new_conversation: "A new conversation is created",
  no_reply: "No agent reply within N hours",
  customer_requests_human: "Customer asks for a human agent",
}

export const AUTOMATION_ACTIONS = [
  "send_template",
  "send_text",
  "assign_department",
  "assign_agent",
  "notify",
] as const
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number]

export const AUTOMATION_ACTION_LABEL: Record<AutomationAction, string> = {
  send_template: "Send an approved template",
  send_text: "Send a text reply (in-window only)",
  assign_department: "Route to a department",
  assign_agent: "Assign to an agent",
  notify: "Notify the department / manager",
}

/** Segmentation fields available to the audience builder (spec §22). */
export const AUDIENCE_FIELDS = [
  "tag",
  "city",
  "state",
  "country",
  "lead_status",
  "department",
  "assigned_agent",
  "last_interaction_days",
  "opted_in",
  "has_conversation",
] as const
export type AudienceField = (typeof AUDIENCE_FIELDS)[number]

export const AUDIENCE_OPERATORS = ["eq", "neq", "contains", "gt", "lt", "in"] as const
export type AudienceOperator = (typeof AUDIENCE_OPERATORS)[number]

export type AudienceCondition = {
  field: AudienceField
  op: AudienceOperator
  value: string
}

export type AudienceFilter = {
  match: "AND" | "OR"
  conditions: AudienceCondition[]
}

/** The default 24/7-off working hours template (used when a dept has none). */
export const DEFAULT_WORKING_HOURS: Record<string, { open: string; close: string; enabled: boolean }> = {
  "0": { open: "10:00", close: "18:00", enabled: false },
  "1": { open: "09:30", close: "18:30", enabled: true },
  "2": { open: "09:30", close: "18:30", enabled: true },
  "3": { open: "09:30", close: "18:30", enabled: true },
  "4": { open: "09:30", close: "18:30", enabled: true },
  "5": { open: "09:30", close: "18:30", enabled: true },
  "6": { open: "10:00", close: "14:00", enabled: true },
}
