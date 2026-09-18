// =============================================================================
// SPEC 13 — Segregation of Duties: conflict matrix (Phase 1).
// -----------------------------------------------------------------------------
// Pure, DB-free catalog of the sensitive DUTIES a user can hold and the
// CONFLICTS between them that a single person must never combine. This is the
// static half of the SoD control: it never touches the database or the request,
// so it can be reasoned about and unit tested in isolation. Per-tenant
// enable/disable, enforcement mode and severity overrides — plus admin-authored
// custom conflicts — layer on top in lib/sod.ts.
//
// A DUTY is resolved to a concrete "does this user hold it?" answer from one of
// two signals:
//   - permission : the user's effective permission matrix grants a capability
//                  category (e.g. "create") on a permission module.
//   - approval   : the user is a configured approver (directly, by role, or by
//                  department) for an approval-authority module (SPEC 11).
//
// A CONFLICT pairs two duties that are incompatible when co-held by one user —
// the classic maker-cannot-be-checker separation the spec enumerates:
//   create vendor + approve vendor
//   create payment + approve payment
//   create employee + approve payroll
//   create journal + approve journal
// =============================================================================

import type { ActionCategory } from "./permission-model"

/** How a duty is detected for a given user. */
export type DutySignal =
  | { type: "permission"; moduleKey: string; category: ActionCategory }
  | { type: "approval"; moduleKeys: string[] }

/** A single sensitive capability. */
export type SodDuty = {
  key: string
  label: string
  /** Business domain used to group create/approve pairs in the UI. */
  domain: string
  /** Whether this duty is the "maker" (create) or "checker" (approve) side. */
  side: "create" | "approve"
  description: string
  signal: DutySignal
}

export type SodSeverity = "low" | "medium" | "high" | "critical"
export type SodEnforcement = "block" | "warn"

/** A built-in incompatible pair of duties. */
export type SodConflictDef = {
  key: string
  label: string
  description: string
  dutyA: string
  dutyB: string
  severity: SodSeverity
  /** Default enforcement when a tenant has not overridden it. */
  defaultEnforcement: SodEnforcement
  /** Whether the conflict is active by default for a tenant. */
  defaultEnabled: boolean
}

export const SOD_SEVERITIES: SodSeverity[] = ["low", "medium", "high", "critical"]
export const SOD_ENFORCEMENTS: SodEnforcement[] = ["block", "warn"]

// -----------------------------------------------------------------------------
// Duty catalog
// -----------------------------------------------------------------------------

export const SOD_DUTIES: SodDuty[] = [
  // Vendors -------------------------------------------------------------------
  {
    key: "vendor.create",
    label: "Create vendor",
    domain: "Vendors",
    side: "create",
    description: "Add or edit vendor / supplier master records.",
    signal: { type: "permission", moduleKey: "finance.customers_vendors", category: "create" },
  },
  {
    key: "vendor.approve",
    label: "Approve vendor",
    domain: "Vendors",
    side: "approve",
    description: "Act as an approver for vendor / supplier onboarding requests.",
    signal: { type: "approval", moduleKeys: ["finance.vendors", "finance.customers_vendors"] },
  },
  // Payments ------------------------------------------------------------------
  {
    key: "payment.create",
    label: "Create payment",
    domain: "Payments",
    side: "create",
    description: "Record outgoing payments / bank disbursements.",
    signal: { type: "permission", moduleKey: "finance.bank_transactions", category: "create" },
  },
  {
    key: "payment.approve",
    label: "Approve payment",
    domain: "Payments",
    side: "approve",
    description: "Act as an approver for payment / disbursement requests.",
    signal: { type: "approval", moduleKeys: ["finance.payments", "finance.bank_transactions"] },
  },
  // Employees / Payroll -------------------------------------------------------
  {
    key: "employee.create",
    label: "Create employee",
    domain: "Employees & Payroll",
    side: "create",
    description: "Add or edit employee master records.",
    signal: { type: "permission", moduleKey: "hr.employees", category: "create" },
  },
  {
    key: "payroll.approve",
    label: "Approve payroll",
    domain: "Employees & Payroll",
    side: "approve",
    description: "Act as an approver for payroll runs.",
    signal: { type: "approval", moduleKeys: ["hr.payroll", "hr.payslips", "hr.salary"] },
  },
  // Journal -------------------------------------------------------------------
  {
    key: "journal.create",
    label: "Create journal",
    domain: "Journal & Ledger",
    side: "create",
    description: "Post journal entries to the ledger.",
    signal: { type: "permission", moduleKey: "finance.journal", category: "create" },
  },
  {
    key: "journal.approve",
    label: "Approve journal",
    domain: "Journal & Ledger",
    side: "approve",
    description: "Act as an approver for journal entries.",
    signal: { type: "approval", moduleKeys: ["finance.journal", "finance.journals"] },
  },
]

const DUTY_BY_KEY = new Map(SOD_DUTIES.map((d) => [d.key, d]))
export function getDuty(key: string): SodDuty | undefined {
  return DUTY_BY_KEY.get(key)
}

// -----------------------------------------------------------------------------
// Built-in conflict matrix
// -----------------------------------------------------------------------------

export const SOD_CONFLICTS: SodConflictDef[] = [
  {
    key: "vendor.create-vs-approve",
    label: "Create vendor + approve vendor",
    description: "The person who creates vendor records must not also approve them.",
    dutyA: "vendor.create",
    dutyB: "vendor.approve",
    severity: "high",
    defaultEnforcement: "block",
    defaultEnabled: true,
  },
  {
    key: "payment.create-vs-approve",
    label: "Create payment + approve payment",
    description: "The person who records payments must not also approve them.",
    dutyA: "payment.create",
    dutyB: "payment.approve",
    severity: "critical",
    defaultEnforcement: "block",
    defaultEnabled: true,
  },
  {
    key: "employee.create-vs-payroll.approve",
    label: "Create employee + approve payroll",
    description: "The person who creates employee records must not also approve payroll.",
    dutyA: "employee.create",
    dutyB: "payroll.approve",
    severity: "high",
    defaultEnforcement: "block",
    defaultEnabled: true,
  },
  {
    key: "journal.create-vs-approve",
    label: "Create journal + approve journal",
    description: "The person who posts journal entries must not also approve them.",
    dutyA: "journal.create",
    dutyB: "journal.approve",
    severity: "high",
    defaultEnforcement: "block",
    defaultEnabled: true,
  },
]

const CONFLICT_BY_KEY = new Map(SOD_CONFLICTS.map((c) => [c.key, c]))
export function getBuiltinConflict(key: string): SodConflictDef | undefined {
  return CONFLICT_BY_KEY.get(key)
}
