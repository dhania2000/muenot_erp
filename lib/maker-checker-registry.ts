/**
 * Maker-Checker · Phase 1: identify high-risk operations.
 *
 * The authoritative catalogue of sensitive operations that must pass through a
 * maker-checker (four-eyes) gate before they take effect. This module is PURE
 * data + pure helpers — no DB, no I/O — so the set of governed operations is
 * declarative, reviewable, and unit-testable.
 *
 * Each operation maps to an approval-engine `moduleKey`, so admins
 * configure *who* must approve using the existing approval-authority rules,
 * while this registry defines *what* is high-risk and therefore gated.
 */

export type MakerCheckerCategory =
  | "vendor"
  | "banking"
  | "payment"
  | "accounting"
  | "tax"
  | "access"
  | "master-data"

export type MakerCheckerOperation = {
  /** Stable, storable identifier for the operation. Never reuse or renumber. */
  key: string
  /** Approval-engine module key used to select the governing approval rule. */
  moduleKey: string
  /** Human label shown in the admin console and the approval inbox. */
  label: string
  category: MakerCheckerCategory
  /** Why the operation is sensitive — shown to admins configuring the gate. */
  description: string
  /**
   * Whether the gate is ON by default for a fresh tenant. High-blast-radius
   * money/access operations default ON; the tenant can still toggle any of
   * them from the admin console.
   */
  defaultEnabled: boolean
}

/**
 * The eight high-risk operation families called out by. Keys are
 * namespaced `domain.entity.action` so new operations slot in without
 * colliding, and so the key can be persisted on a change record forever.
 */
export const MAKER_CHECKER_OPERATIONS: readonly MakerCheckerOperation[] = [
  {
    key: "finance.vendor.create",
    moduleKey: "finance.vendors",
    label: "Vendor creation",
    category: "vendor",
    description:
      "Onboarding a new vendor creates a payable counterparty. A rogue or duplicate vendor is the classic conduit for fraudulent disbursement, so creation is held until a second person approves.",
    defaultEnabled: true,
  },
  {
    key: "finance.vendor.bank_change",
    moduleKey: "finance.vendors",
    label: "Vendor bank change",
    category: "banking",
    description:
      "Changing a vendor's bank account or IFSC redirects where money is paid. This is the single most abused master-data field in payment fraud and is always gated.",
    defaultEnabled: true,
  },
  {
    key: "hr.employee.bank_change",
    moduleKey: "hr.employees",
    label: "Employee bank change",
    category: "banking",
    description:
      "Changing an employee's salary bank account redirects payroll. Gated to prevent payroll diversion.",
    defaultEnabled: true,
  },
  {
    key: "finance.payment.create",
    moduleKey: "finance.payments",
    label: "Payment creation",
    category: "payment",
    description:
      "Recording a payment moves money and posts to the ledger. The maker prepares it; a checker releases it.",
    defaultEnabled: true,
  },
  {
    key: "finance.journal.post",
    moduleKey: "finance.journal",
    label: "Journal posting",
    category: "accounting",
    description:
      "Posting a manual journal writes directly to the general ledger and can restate results. Posting is separated from preparation.",
    defaultEnabled: false,
  },
  {
    key: "finance.tax.config",
    moduleKey: "finance.tax_config",
    label: "Tax configuration",
    category: "tax",
    description:
      "Changing tax rates, TDS sections or GST settings affects every downstream computation and statutory filing. Changes are reviewed before they apply.",
    defaultEnabled: true,
  },
  {
    key: "admin.user.permissions",
    moduleKey: "admin.permissions",
    label: "User permissions",
    category: "access",
    description:
      "Granting or revoking a user's access rights is privilege escalation. A second administrator must confirm the change (four-eyes on access).",
    defaultEnabled: true,
  },
  {
    key: "masterdata.change",
    moduleKey: "masterdata",
    label: "Master-data change",
    category: "master-data",
    description:
      "Edits to shared master data (chart of accounts, cost centres, legal entities and other reference data) ripple across the whole ledger and are reviewed before they take effect.",
    defaultEnabled: false,
  },
] as const

const BY_KEY = new Map<string, MakerCheckerOperation>(MAKER_CHECKER_OPERATIONS.map((op) => [op.key, op]))

/** All governed operations, in catalogue order. */
export function listOperations(): readonly MakerCheckerOperation[] {
  return MAKER_CHECKER_OPERATIONS
}

/** Look up one operation by its stable key, or null when unknown. */
export function getOperation(key: string): MakerCheckerOperation | null {
  return BY_KEY.get(key) ?? null
}

/** True when the key names a registered high-risk operation. */
export function isKnownOperation(key: string): boolean {
  return BY_KEY.has(key)
}

/** The default enabled/disabled state for every operation, keyed by op key. */
export function defaultGateState(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const op of MAKER_CHECKER_OPERATIONS) out[op.key] = op.defaultEnabled
  return out
}
