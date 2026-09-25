import { describe, it, expect } from "vitest"
import {
  CUSTOMER_FINANCE_TABLES,
  FinanceBoundaryError,
  PLATFORM_LEDGER_TABLES,
  PLATFORM_SOURCE_TYPES,
  assertPlatformLedgerTarget,
  assertPlatformSourceType,
  isCustomerFinanceTable,
  isPlatformLedgerTable,
  isPlatformSourceType,
} from "@/lib/billing/finance-boundary"

/**
 * Spec62 (#242-244) — the finance boundary guard.
 *
 * The platform seller ledger and each customer tenant's ERP finance are scoped
 * by the same tenant_id, so the ONLY thing keeping seller money out of a
 * customer's books is this guard. These pure tests are its evidence: a seller
 * posting can never be routed at a customer finance table, and only recognized
 * platform ledger tables / source types are accepted.
 */

describe("table classification", () => {
  it("recognizes the platform ledger tables", () => {
    expect(PLATFORM_LEDGER_TABLES).toContain("platform_journal")
    expect(PLATFORM_LEDGER_TABLES).toContain("platform_journal_lines")
    for (const t of PLATFORM_LEDGER_TABLES) {
      expect(isPlatformLedgerTable(t)).toBe(true)
      expect(isCustomerFinanceTable(t)).toBe(false)
    }
  })

  it("recognizes the customer finance tables", () => {
    expect(CUSTOMER_FINANCE_TABLES).toContain("general_ledger")
    expect(CUSTOMER_FINANCE_TABLES).toContain("journal_entries")
    for (const t of CUSTOMER_FINANCE_TABLES) {
      expect(isCustomerFinanceTable(t)).toBe(true)
      expect(isPlatformLedgerTable(t)).toBe(false)
    }
  })

  it("normalizes backticks / case / whitespace", () => {
    expect(isPlatformLedgerTable("`platform_journal`")).toBe(true)
    expect(isPlatformLedgerTable("  PLATFORM_JOURNAL  ")).toBe(true)
    expect(isCustomerFinanceTable("`General_Ledger`")).toBe(true)
  })

  it("the two ledger table sets never overlap", () => {
    for (const t of PLATFORM_LEDGER_TABLES) {
      expect((CUSTOMER_FINANCE_TABLES as readonly string[]).includes(t)).toBe(false)
    }
  })
})

describe("assertPlatformLedgerTarget — fail closed", () => {
  it("accepts the platform ledger tables", () => {
    expect(() => assertPlatformLedgerTarget("platform_journal")).not.toThrow()
    expect(() => assertPlatformLedgerTarget("platform_journal_lines")).not.toThrow()
  })

  it("REJECTS a seller posting aimed at any customer finance table", () => {
    for (const t of CUSTOMER_FINANCE_TABLES) {
      expect(() => assertPlatformLedgerTarget(t)).toThrow(FinanceBoundaryError)
      expect(() => assertPlatformLedgerTarget(t)).toThrow(/customer finance/i)
    }
  })

  it("rejects any unrecognized table", () => {
    expect(() => assertPlatformLedgerTarget("random_table")).toThrow(FinanceBoundaryError)
    expect(() => assertPlatformLedgerTarget("")).toThrow(FinanceBoundaryError)
  })

  it("the error carries a 422 status", () => {
    try {
      assertPlatformLedgerTarget("general_ledger")
      throw new Error("expected to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(FinanceBoundaryError)
      expect((err as FinanceBoundaryError).status).toBe(422)
    }
  })
})

describe("platform source types", () => {
  it("accepts each known platform source type", () => {
    for (const s of PLATFORM_SOURCE_TYPES) {
      expect(isPlatformSourceType(s)).toBe(true)
      expect(() => assertPlatformSourceType(s)).not.toThrow()
    }
  })

  it("rejects an unknown source type", () => {
    expect(isPlatformSourceType("customer_invoice")).toBe(false)
    expect(() => assertPlatformSourceType("customer_invoice")).toThrow(FinanceBoundaryError)
  })
})
