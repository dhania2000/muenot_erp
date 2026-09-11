/**
 * Shared WhatsApp inbox constants + types usable from BOTH server and client.
 *
 * Kept free of any server-only imports (no DB, no "server-only") so the inbox
 * UI, the API routes and the data layer all agree on the same vocabulary for
 * teams, priorities and conversation statuses.
 */

/** Teams a conversation can be routed to. Mirrors the ERP's functional desks. */
export const WHATSAPP_TEAMS = ["Sales", "Support", "Admin", "Marketing"] as const
export type WhatsAppTeam = (typeof WHATSAPP_TEAMS)[number]

export const WHATSAPP_PRIORITIES = ["low", "normal", "high", "urgent"] as const
export type WhatsAppPriority = (typeof WHATSAPP_PRIORITIES)[number]

export const WHATSAPP_STATUSES = ["open", "pending", "closed"] as const
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number]

/** Assignment "view" presets used by the inbox left-hand filter. */
export const WHATSAPP_INBOX_VIEWS = ["all", "mine", "unassigned"] as const
export type WhatsAppInboxView = (typeof WHATSAPP_INBOX_VIEWS)[number]

export function isWhatsAppTeam(value: unknown): value is WhatsAppTeam {
  return typeof value === "string" && (WHATSAPP_TEAMS as readonly string[]).includes(value)
}

export function isWhatsAppPriority(value: unknown): value is WhatsAppPriority {
  return typeof value === "string" && (WHATSAPP_PRIORITIES as readonly string[]).includes(value)
}

export function isWhatsAppStatus(value: unknown): value is WhatsAppStatus {
  return typeof value === "string" && (WHATSAPP_STATUSES as readonly string[]).includes(value)
}

export const PRIORITY_LABEL: Record<WhatsAppPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
}

export const STATUS_LABEL: Record<WhatsAppStatus, string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
}
