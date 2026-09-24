/**
 * SPEC 119 — Vendor Portal · Architecture (Phase 1)
 * ---------------------------------------------------------------------------
 * The vendor portal is an OPTIONAL, EXTERNAL-facing surface that lets a
 * tenant's vendors ("suppliers") sign in and see a curated set of records that
 * pertain to them (purchase orders, invoices they submit, payment status,
 * documents, compliance) and message the tenant's accounts-payable team.
 *
 * It is a completely separate identity + access plane from the internal ERP
 * AND from the client portal (SPEC 118):
 *
 *   Internal app          Client portal            Vendor portal
 *   -------------------   ----------------------   ---------------------------
 *   users                 client_portal_users      vendor_portal_users
 *   cookie: ems_session   ems_portal_session       ems_vendor_portal_session
 *   /dashboard /modules   /portal/*                /vendor-portal/*
 *   /api/admin ...        /api/portal/*            /api/vendor-portal/*
 *
 * ISOLATION MODEL (two axes, both enforced on every read/write):
 *   1. tenant_id  — every vendor-portal table carries tenant_id and is
 *      registered in lib/tenant-tables.ts, so the fail-closed data-layer guard
 *      (lib/tenant-guard.ts) rejects any query missing a tenant filter.
 *   2. vendor_id  — a portal user belongs to exactly ONE vendor. The store
 *      layer scopes EVERY query to both the tenant AND the vendor resolved from
 *      the verified vendor-portal session, never from portal-user input. This
 *      stops one vendor from seeing another vendor's data within a tenant.
 *
 * DATA MODEL: the portal is a curated SHARING layer, not a direct window onto
 * the finance schema. Internal AP staff publish records (POs, payment status,
 * documents, compliance items) to a vendor; the vendor can submit invoices and
 * exchange messages. This keeps the portal decoupled from — and safe against —
 * the finance module's evolving schema.
 */

export const VENDOR_PORTAL_SESSION_COOKIE = "ems_vendor_portal_session"

/** Every resource a vendor can be granted access to (SPEC 119). */
export const VENDOR_PORTAL_RESOURCES = [
  "purchase-orders",
  "invoices",
  "payments",
  "documents",
  "compliance",
  "messages",
] as const

export type VendorPortalResource = (typeof VENDOR_PORTAL_RESOURCES)[number]

export function isVendorPortalResource(value: string): value is VendorPortalResource {
  return (VENDOR_PORTAL_RESOURCES as readonly string[]).includes(value)
}

/** The read-only / submitted "shared record" resource types stored in vendor_portal_items. */
export const VENDOR_PORTAL_ITEM_RESOURCES = [
  "purchase-orders",
  "invoices",
  "payments",
  "documents",
  "compliance",
] as const

export type VendorPortalItemResource = (typeof VENDOR_PORTAL_ITEM_RESOURCES)[number]

export function isVendorPortalItemResource(value: string): value is VendorPortalItemResource {
  return (VENDOR_PORTAL_ITEM_RESOURCES as readonly string[]).includes(value)
}

export type VendorPortalResourceMeta = {
  key: VendorPortalResource
  /** Singular label. */
  label: string
  /** Plural / section label. */
  labelPlural: string
  /** Short description for empty states and the dashboard. */
  description: string
  /** Whether vendors can CREATE / SUBMIT records of this type from the portal. */
  vendorCanCreate: boolean
}

export const VENDOR_PORTAL_RESOURCE_META: Record<VendorPortalResource, VendorPortalResourceMeta> = {
  "purchase-orders": {
    key: "purchase-orders",
    label: "Purchase Order",
    labelPlural: "Purchase Orders",
    description: "Purchase orders issued to you, with quantities, values and current status.",
    vendorCanCreate: false,
  },
  invoices: {
    key: "invoices",
    label: "Invoice",
    labelPlural: "Invoices",
    description: "Submit invoices against your purchase orders and track their approval.",
    vendorCanCreate: true,
  },
  payments: {
    key: "payments",
    label: "Payment",
    labelPlural: "Payment Status",
    description: "Payments recorded against your invoices and their settlement status.",
    vendorCanCreate: false,
  },
  documents: {
    key: "documents",
    label: "Document",
    labelPlural: "Documents",
    description: "Contracts, remittance advices and other files shared with you.",
    vendorCanCreate: false,
  },
  compliance: {
    key: "compliance",
    label: "Compliance Item",
    labelPlural: "Compliance",
    description: "KYC, GST, MSME and other compliance requirements and their status.",
    vendorCanCreate: false,
  },
  messages: {
    key: "messages",
    label: "Message",
    labelPlural: "Messages",
    description: "Direct messages with the accounts-payable team.",
    vendorCanCreate: true,
  },
}

/** Default access granted to a new vendor portal user (all resources; staff can restrict). */
export const DEFAULT_VENDOR_PORTAL_RESOURCES: VendorPortalResource[] = [...VENDOR_PORTAL_RESOURCES]
