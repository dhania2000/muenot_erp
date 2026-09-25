/**
 * The finance boundary between the SaaS platform's own books and each customer
 * tenant's ERP finance (Spec62, #242-244).
 * ---------------------------------------------------------------------------
 * Muenot both RUNS the ERP internally AND SELLS it as SaaS. When it bills a
 * customer tenant for their subscription, that is the PLATFORM's revenue and
 * receivable: it must be recorded ONLY in the platform seller ledger
 * (`platform_journal` / `platform_journal_lines`) and must NEVER post into that
 * customer's own ERP finance ledger (`general_ledger` / `journal_entries`),
 * which records the customer's own business. Both sets of books happen to be
 * scoped by the same `tenant_id` ("the platform's account with this customer"
 * vs. "this customer's own books"), so the ONLY thing keeping seller money out
 * of customer finance is this boundary — hence a single, explicit guard.
 *
 * This module is intentionally free of DB / `server-only` imports so the
 * invariant is unit-testable and can be reused on both sides of every posting
 * seam. It is the one place that names the two ledgers and enforces that a
 * SaaS-seller posting can never land in customer finance.
 */

/** Tables that make up the platform seller ledger (the SaaS provider's books). */
export const PLATFORM_LEDGER_TABLES = ["platform_journal", "platform_journal_lines"] as const
export type PlatformLedgerTable = (typeof PLATFORM_LEDGER_TABLES)[number]

/**
 * Customer-tenant ERP finance tables that a SaaS seller posting must never
 * touch. Kept as an explicit deny-list (rather than "anything not in the
 * platform set") so the guard names the real customer books it is protecting
 * and stays correct even as new platform-side tables are added.
 */
export const CUSTOMER_FINANCE_TABLES = [
  "general_ledger",
  "journal_entries",
  "journal_entry_lines",
  "journal_lines",
] as const
export type CustomerFinanceTable = (typeof CUSTOMER_FINANCE_TABLES)[number]

/** Platform seller posting source types (mirror of platform-ledger `SourceType`). */
export const PLATFORM_SOURCE_TYPES = ["invoice", "payment", "refund", "credit", "recognition"] as const
export type PlatformSourceType = (typeof PLATFORM_SOURCE_TYPES)[number]

function normalizeTable(table: string): string {
  return String(table ?? "")
    .trim()
    .replace(/`/g, "")
    .toLowerCase()
}

export function isPlatformLedgerTable(table: string): boolean {
  return (PLATFORM_LEDGER_TABLES as readonly string[]).includes(normalizeTable(table))
}

export function isCustomerFinanceTable(table: string): boolean {
  return (CUSTOMER_FINANCE_TABLES as readonly string[]).includes(normalizeTable(table))
}

export function isPlatformSourceType(sourceType: string): boolean {
  return (PLATFORM_SOURCE_TYPES as readonly string[]).includes(String(sourceType))
}

/** Thrown when a posting would cross the platform/customer finance boundary. */
export class FinanceBoundaryError extends Error {
  status: number
  constructor(message: string, status = 422) {
    super(message)
    this.name = "FinanceBoundaryError"
    this.status = status
  }
}

/**
 * Assert that a SaaS-seller / platform posting is targeting the platform ledger.
 * Fails closed when the target is a customer finance table (the exact boundary
 * violation we defend against — seller money leaking into a customer's books) or
 * when it is any table that is not a recognized platform ledger table. This is
 * the guard the seller-side posting seam (`postJournal`) calls before every
 * write, so a future code change can never quietly route seller money into
 * customer finance.
 */
export function assertPlatformLedgerTarget(table: string): void {
  if (isCustomerFinanceTable(table)) {
    throw new FinanceBoundaryError(
      `Finance boundary violation: a SaaS seller posting attempted to write to customer finance table "${normalizeTable(
        table,
      )}". Seller invoices post only to the platform ledger.`,
    )
  }
  if (!isPlatformLedgerTable(table)) {
    throw new FinanceBoundaryError(
      `Finance boundary violation: seller posting target "${normalizeTable(table)}" is not a platform ledger table.`,
    )
  }
}

/**
 * Assert a value is a recognized platform seller source type. Guards the entry
 * point so an unknown source can never be misrouted into the platform ledger.
 */
export function assertPlatformSourceType(sourceType: string): void {
  if (!isPlatformSourceType(sourceType)) {
    throw new FinanceBoundaryError(`Finance boundary violation: "${sourceType}" is not a platform seller source type.`)
  }
}
