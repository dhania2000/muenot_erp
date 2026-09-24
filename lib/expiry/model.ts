/**
 * Domain types & categorisation for the Document Expiry service (SPEC 88).
 * Pure — safe to import from tests and both server/client boundaries.
 */
import type { EscalationTier, ExpiryStatus, RenewalStatus } from "@/lib/expiry/date"

export const EXPIRY_CATEGORIES = [
  "Contract",
  "Certification",
  "License",
  "Insurance",
  "Compliance",
  "Identity",
  "Employee Document",
] as const

export type ExpiryCategory = (typeof EXPIRY_CATEGORIES)[number]

/**
 * A raw expiry-bearing record emitted by a source, before the date engine has
 * classified it. `expiryDate` is a canonical `YYYY-MM-DD` string (or null when
 * the source row had no usable date and should be skipped by the caller).
 */
export type ExpirySourceRow = {
  sourceId: string
  sourceLabel: string
  category: ExpiryCategory
  entityId: string
  title: string
  subtitle: string | null
  expiryDate: string | null
  issueDate: string | null
  documentNumber: string | null
  warnDays: number
  link: string
  /** hr_employees.user_id of the owner, when the record belongs to a person. */
  ownerUserId: number | null
}

/** A source row after the date engine has classified it. */
export type ExpiryItem = ExpirySourceRow & {
  expiryDate: string
  daysUntil: number
  status: ExpiryStatus
  escalation: EscalationTier
  renewalStatus: RenewalStatus
  milestone: string | null
}

/**
 * Classify a free-text document type into an expiry category. Order matters:
 * more specific keywords are checked first.
 */
export function categorizeDocumentType(typeName: string | null | undefined): ExpiryCategory {
  const t = (typeName ?? "").toLowerCase()
  if (/insur|indemnit|policy no|liabilit/.test(t)) return "Insurance"
  if (/licen[cs]|permit|registration cert|driving/.test(t)) return "License"
  if (/certif|iso|accredit|training cert|competen/.test(t)) return "Certification"
  if (/complian|nda|noc|gdpr|kyc|background|clearance/.test(t)) return "Compliance"
  if (/passport|visa|aadhar|aadhaar|\bpan\b|identity|national id|residence/.test(t)) return "Identity"
  return "Employee Document"
}

/** Tailwind badge classes for each status (matches the app's token palette). */
export function statusBadgeClass(status: ExpiryStatus): string {
  switch (status) {
    case "Expired":
      return "bg-destructive/10 text-destructive border-destructive/20"
    case "Expiring Soon":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400"
    case "Valid":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400"
    default:
      return "bg-muted text-muted-foreground border-border"
  }
}
