/**
 * SPEC 118 — Client Portal · Architecture (Phase 1)
 * ---------------------------------------------------------------------------
 * The client portal is an OPTIONAL, EXTERNAL-facing surface that lets a
 * tenant's customers ("clients") sign in and see a curated set of records that
 * pertain to them. It is a completely separate identity + access plane from
 * the internal ERP:
 *
 *   Internal app                     Client portal
 *   ------------------------------   ------------------------------
 *   users table (admin/employee)     client_portal_users (external)
 *   cookie: ems_session              cookie: ems_portal_session
 *   routes: /dashboard /modules      routes: /portal/*
 *   api:    /api/admin /api/modules  api:    /api/portal/*
 *
 * ISOLATION MODEL (two axes, both enforced on every read/write):
 *   1. tenant_id  — every portal table carries tenant_id and is registered in
 *      lib/tenant-tables.ts, so the fail-closed data-layer guard
 *      (lib/tenant-guard.ts) rejects any portal query missing a tenant filter.
 *   2. client_id  — a portal user only ever belongs to ONE client. The store
 *      layer (lib/portal/store.ts) scopes EVERY query to both the tenant AND
 *      the client resolved from the verified portal session, never from client
 *      input. This is what stops one client from seeing another client's data
 *      inside the same tenant.
 *
 * DATA MODEL: the portal is a curated SHARING layer, not a direct window onto
 * every internal module's schema. Internal staff publish records (quotes,
 * orders, invoices, payments, documents, projects) to a client; the client can
 * also open support tickets and exchange messages. This keeps the portal
 * decoupled from — and safe against — the internal modules' evolving schemas.
 */

export const PORTAL_SESSION_COOKIE = "ems_portal_session"

/** Every resource a client can be granted access to (SPEC 118). */
export const PORTAL_RESOURCES = [
  "quotes",
  "orders",
  "invoices",
  "payments",
  "documents",
  "tickets",
  "projects",
  "messages",
] as const

export type PortalResource = (typeof PORTAL_RESOURCES)[number]

export function isPortalResource(value: string): value is PortalResource {
  return (PORTAL_RESOURCES as readonly string[]).includes(value)
}

/** The read-only "shared record" resource types stored in client_portal_items. */
export const PORTAL_ITEM_RESOURCES = [
  "quotes",
  "orders",
  "invoices",
  "payments",
  "documents",
  "projects",
] as const

export type PortalItemResource = (typeof PORTAL_ITEM_RESOURCES)[number]

export function isPortalItemResource(value: string): value is PortalItemResource {
  return (PORTAL_ITEM_RESOURCES as readonly string[]).includes(value)
}

export type PortalResourceMeta = {
  key: PortalResource
  /** Singular label. */
  label: string
  /** Plural / section label. */
  labelPlural: string
  /** Short description for empty states and the dashboard. */
  description: string
  /** Whether clients can CREATE records of this type from the portal. */
  clientCanCreate: boolean
}

export const PORTAL_RESOURCE_META: Record<PortalResource, PortalResourceMeta> = {
  quotes: {
    key: "quotes",
    label: "Quote",
    labelPlural: "Quotes",
    description: "Quotations and estimates shared with you.",
    clientCanCreate: false,
  },
  orders: {
    key: "orders",
    label: "Order",
    labelPlural: "Orders",
    description: "Place new orders and track existing orders and their current status.",
    clientCanCreate: true,
  },
  invoices: {
    key: "invoices",
    label: "Invoice",
    labelPlural: "Invoices",
    description: "Invoices raised against your account.",
    clientCanCreate: false,
  },
  payments: {
    key: "payments",
    label: "Payment",
    labelPlural: "Payments",
    description: "Payments recorded against your invoices.",
    clientCanCreate: false,
  },
  documents: {
    key: "documents",
    label: "Document",
    labelPlural: "Documents",
    description: "Files and documents shared with you.",
    clientCanCreate: false,
  },
  tickets: {
    key: "tickets",
    label: "Ticket",
    labelPlural: "Support Tickets",
    description: "Raise and track support requests.",
    clientCanCreate: true,
  },
  projects: {
    key: "projects",
    label: "Project",
    labelPlural: "Projects",
    description: "Progress on your active projects.",
    clientCanCreate: false,
  },
  messages: {
    key: "messages",
    label: "Message",
    labelPlural: "Messages",
    description: "Direct messages with your account team.",
    clientCanCreate: true,
  },
}

/** Default access granted to a new portal user (all resources, staff can restrict). */
export const DEFAULT_PORTAL_RESOURCES: PortalResource[] = [...PORTAL_RESOURCES]
