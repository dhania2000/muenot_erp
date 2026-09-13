import "server-only"
import {
  computeExpenseServerFields,
  validateExpense,
  nextExpenseId,
} from "@/lib/finance-expenses"
import { ensureExpenseColumns } from "@/lib/finance-ensure"

/**
 * Per-module server augmentation for the generic bulk importer
 * (see app/api/import/[key]/route.ts).
 *
 * Dedicated-table finance modules (Expenses) own an authoritative create
 * pipeline in finance-crud.ts: master snapshot resolution, the server money
 * recalculation, financial-year / accounting-period derivation, the duplicate
 * fingerprint and the immutable business id. The plain row-insert importer
 * bypasses all of that, so a spreadsheet row would land without a resolved
 * Employee / Vendor / Project snapshot, with browser-provided (untrusted) money
 * and with an id minted from the wrong counter/format.
 *
 * This module lets the importer reuse the exact same authoritative pipeline for
 * those keys so an imported expense is indistinguishable from a hand-created one
 * (Phase 30: "Resolve Employee/Vendor/Project through masters").
 */
export interface ImportAugment {
  idColumn: string
  /** Self-heal the module's columns before the first insert. */
  ensure: () => Promise<void>
  /** Resolve masters + recompute all server-owned fields for one row. */
  augment: (record: Record<string, any>) => Promise<Record<string, any>>
  /** Hard validation; a returned string rejects the row. */
  validate?: (record: Record<string, any>) => string | null
  /** Mint the immutable, concurrency-safe business id. */
  generateId: (record: Record<string, any>) => Promise<string>
}

export const FINANCE_IMPORT_AUGMENTS: Record<string, ImportAugment> = {
  "finance-expenses": {
    idColumn: "expense_id",
    ensure: ensureExpenseColumns,
    augment: (record) => computeExpenseServerFields(record, { isCreate: true }),
    validate: validateExpense,
    generateId: (record) => nextExpenseId(record.expense_date),
  },
}
