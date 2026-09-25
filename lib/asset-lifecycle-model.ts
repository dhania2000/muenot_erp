/**
 * Pure domain model for Asset Warranty & Maintenance (Spec61, #234-239).
 * ---------------------------------------------------------------------------
 * Deliberately free of `server-only`, DB and `Date.now()` so it can be unit
 * tested in isolation (see test/asset-lifecycle.test.ts) and imported from both
 * the server lib and the expiry source registry.
 *
 * These records sit on top of Finance → Fixed Assets: warranty and maintenance
 * always reference an existing `fixed_assets.asset_id`. This module owns NO
 * asset master data and NO depreciation logic — depreciation remains Finance's
 * responsibility; here we only track warranty coverage and maintenance events.
 */
import { evaluateExpiry } from "@/lib/expiry/date"

export const WARRANTY_TYPES = ["Manufacturer", "Extended", "Service Contract", "AMC", "Insurance"] as const
export type WarrantyType = (typeof WARRANTY_TYPES)[number]

export const MAINTENANCE_TYPES = ["Preventive", "Corrective", "Inspection", "Warranty Claim", "Upgrade"] as const
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number]

export const MAINTENANCE_STATUSES = ["Scheduled", "In Progress", "Completed", "Cancelled"] as const
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number]

/** Maintenance statuses that still count as "open" (surfaced for reminders). */
export const OPEN_MAINTENANCE_STATUSES: MaintenanceStatus[] = ["Scheduled", "In Progress"]

/** Default lead time (days) before a warranty/service date to start reminding. */
export const DEFAULT_WARRANTY_WARN_DAYS = 30
export const DEFAULT_SERVICE_WARN_DAYS = 15

const MAX_COST = 1_000_000_000
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class AssetLifecycleError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "AssetLifecycleError"
    this.status = status
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

export const normStr = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

export const dateOf = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null)

export function isValidDate(v: unknown): boolean {
  if (!v) return false
  const s = String(v).slice(0, 10)
  if (!ISO_DATE_RE.test(s)) return false
  const t = Date.parse(s)
  return Number.isFinite(t)
}

function normCost(v: unknown, label: string): number {
  if (v === undefined || v === null || v === "") return 0
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > MAX_COST)
    throw new AssetLifecycleError(`${label} must be between 0 and ${MAX_COST.toLocaleString()}.`)
  return Math.round(n * 100) / 100
}

function normWarnDays(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 3650)
    throw new AssetLifecycleError("Reminder days must be between 0 and 3650.")
  return Math.trunc(n)
}

/**
 * Advance a `YYYY-MM-DD` date forward by a whole number of calendar months,
 * clamping to the last valid day of the target month (e.g. Jan 31 + 1mo → Feb
 * 28/29). Used to roll a completed service into its next scheduled service date.
 */
export function advanceServiceDate(iso: string, months: number): string {
  if (!isValidDate(iso)) throw new AssetLifecycleError("Service date is invalid.")
  if (!Number.isFinite(months) || months <= 0) throw new AssetLifecycleError("Service interval must be positive.")
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  const target = new Date(Date.UTC(y, m - 1 + Math.trunc(months), 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  const yy = target.getUTCFullYear()
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(day).padStart(2, "0")
  return `${yy}-${mm}-${dd}`
}

/** Classify a warranty/service date through the shared expiry date engine. */
export function classifyExpiry(
  expiryDate: string | null,
  opts: { now?: Date; timeZone?: string; warnDays?: number } = {},
) {
  return evaluateExpiry(expiryDate, opts)
}

// ── Input validation (server + tests share these) ───────────────────────────────

export type WarrantyInput = {
  finance_fixed_asset_id?: string | number
  provider?: string
  warranty_type?: string
  coverage?: string | null
  start_date?: string | null
  expiry_date?: string | null
  reference_no?: string | null
  cost?: number | string | null
  reminder_days?: number | string | null
  notes?: string | null
}

export type NormalizedWarranty = {
  finance_fixed_asset_id: string
  provider: string
  warranty_type: WarrantyType
  coverage: string | null
  start_date: string | null
  expiry_date: string
  reference_no: string | null
  cost: number
  reminder_days: number
  notes: string | null
}

export function validateWarrantyInput(input: WarrantyInput, isUpdate = false): NormalizedWarranty {
  const assetId = normStr(input.finance_fixed_asset_id)
  if (!isUpdate && !assetId) throw new AssetLifecycleError("Please select a fixed asset.")

  const provider = normStr(input.provider)
  if (!provider) throw new AssetLifecycleError("Warranty provider is required.")

  const warrantyType = (normStr(input.warranty_type) ?? "Manufacturer") as WarrantyType
  if (!WARRANTY_TYPES.includes(warrantyType))
    throw new AssetLifecycleError(`Invalid warranty type. Expected one of: ${WARRANTY_TYPES.join(", ")}.`)

  const startDate = dateOf(input.start_date)
  if (startDate && !isValidDate(startDate)) throw new AssetLifecycleError("Start date is invalid.")

  const expiryDate = dateOf(input.expiry_date)
  if (!expiryDate || !isValidDate(expiryDate)) throw new AssetLifecycleError("A valid warranty expiry date is required.")
  if (startDate && expiryDate < startDate)
    throw new AssetLifecycleError("Warranty expiry date cannot be earlier than the start date.")

  return {
    finance_fixed_asset_id: assetId ?? "",
    provider,
    warranty_type: warrantyType,
    coverage: normStr(input.coverage),
    start_date: startDate,
    expiry_date: expiryDate,
    reference_no: normStr(input.reference_no),
    cost: normCost(input.cost, "Warranty cost"),
    reminder_days: normWarnDays(input.reminder_days, DEFAULT_WARRANTY_WARN_DAYS),
    notes: normStr(input.notes),
  }
}

export type MaintenanceInput = {
  finance_fixed_asset_id?: string | number
  assignment_id?: string | null
  maintenance_type?: string
  status?: string
  scheduled_date?: string | null
  performed_date?: string | null
  vendor_party_id?: string | number | null
  vendor_name?: string | null
  cost?: number | string | null
  description?: string | null
  next_service_date?: string | null
  reminder_days?: number | string | null
  notes?: string | null
  idempotency_key?: string | null
}

export type NormalizedMaintenance = {
  finance_fixed_asset_id: string
  assignment_id: string | null
  maintenance_type: MaintenanceType
  status: MaintenanceStatus
  scheduled_date: string | null
  performed_date: string | null
  vendor_party_id: string | null
  vendor_name: string | null
  cost: number
  description: string
  next_service_date: string | null
  reminder_days: number
  notes: string | null
  idempotency_key: string | null
}

export function validateMaintenanceInput(input: MaintenanceInput, isUpdate = false): NormalizedMaintenance {
  const assetId = normStr(input.finance_fixed_asset_id)
  if (!isUpdate && !assetId) throw new AssetLifecycleError("Please select a fixed asset.")

  const maintenanceType = (normStr(input.maintenance_type) ?? "Corrective") as MaintenanceType
  if (!MAINTENANCE_TYPES.includes(maintenanceType))
    throw new AssetLifecycleError(`Invalid maintenance type. Expected one of: ${MAINTENANCE_TYPES.join(", ")}.`)

  const status = (normStr(input.status) ?? "Scheduled") as MaintenanceStatus
  if (!MAINTENANCE_STATUSES.includes(status))
    throw new AssetLifecycleError(`Invalid status. Expected one of: ${MAINTENANCE_STATUSES.join(", ")}.`)

  const scheduledDate = dateOf(input.scheduled_date)
  if (scheduledDate && !isValidDate(scheduledDate)) throw new AssetLifecycleError("Scheduled date is invalid.")

  const performedDate = dateOf(input.performed_date)
  if (performedDate && !isValidDate(performedDate)) throw new AssetLifecycleError("Performed date is invalid.")
  if (status === "Completed" && !performedDate)
    throw new AssetLifecycleError("A performed date is required to complete a maintenance record.")

  const nextServiceDate = dateOf(input.next_service_date)
  if (nextServiceDate && !isValidDate(nextServiceDate)) throw new AssetLifecycleError("Next service date is invalid.")

  const description = normStr(input.description)
  if (!description) throw new AssetLifecycleError("A maintenance description is required.")

  return {
    finance_fixed_asset_id: assetId ?? "",
    assignment_id: normStr(input.assignment_id),
    maintenance_type: maintenanceType,
    status,
    scheduled_date: scheduledDate,
    performed_date: performedDate,
    vendor_party_id: normStr(input.vendor_party_id),
    vendor_name: normStr(input.vendor_name),
    cost: normCost(input.cost, "Maintenance cost"),
    description,
    next_service_date: nextServiceDate,
    reminder_days: normWarnDays(input.reminder_days, DEFAULT_SERVICE_WARN_DAYS),
    notes: normStr(input.notes),
    idempotency_key: normStr(input.idempotency_key),
  }
}
