import { query } from "@/lib/db"

/**
 * Server-side guards for the Chart of Accounts master.
 *
 * These protect the integrity of the single accounting system shared by the
 * Journal, General Ledger, Purchase Bills, Sales Invoices, Expenses, Bank &
 * Cash, GST, TDS and Reports. Every one of those links resolves accounts by
 * `account_id` / `account_code`, so we enforce unique codes, a valid acyclic
 * parent hierarchy, and a hands-off policy for the posting-engine control
 * accounts (`is_system = 1`).
 */

type CoaRow = Record<string, any>

/**
 * Validate a create/edit before it is written. Returns a user-facing message to
 * reject with (HTTP 400), or null to allow. Runs against the merged record plus
 * its prior committed state on edit.
 */
export async function guardChartOfAccountWrite(
  merged: CoaRow,
  ctx: { isCreate: boolean; existing: CoaRow | null },
): Promise<string | null> {
  const code = (merged.account_code ?? "").toString().trim()
  const existing = ctx.existing

  // 1. Account code must be unique (case-insensitive) when provided. The code
  // is the stable key the posting engine resolves, so duplicates would make
  // resolution ambiguous.
  if (code) {
    const dupes = (await query(
      `SELECT id FROM chart_of_accounts WHERE LOWER(account_code) = LOWER(?)${
        existing?.id ? " AND id <> ?" : ""
      } LIMIT 1`,
      existing?.id ? [code, existing.id] : [code],
    )) as any[]
    if (dupes.length) {
      return `Account code "${code}" is already in use. Codes must be unique.`
    }
  }

  // 2. Protect the posting-engine control accounts. A system account may still
  // be re-parented or re-described, but its identity (code, type) and its
  // active status are frozen so postings never break.
  if (!ctx.isCreate && existing && Number(existing.is_system) === 1) {
    if (code && code !== (existing.account_code ?? "").toString()) {
      return "This is a system account. Its account code is locked and cannot be changed."
    }
    if (
      (merged.account_group ?? "").toString() &&
      (merged.account_group ?? "").toString() !== (existing.account_group ?? "").toString()
    ) {
      return "This is a system account. Its account type is locked and cannot be changed."
    }
    const status = (merged.active_status ?? "").toString()
    if (status && status !== "Active") {
      return "This is a system account and cannot be deactivated or archived — it is required by the posting engine."
    }
  }

  // 3. Parent hierarchy: the parent must exist, cannot be the account itself,
  // and cannot create a cycle.
  const parentId = (merged.parent_account_id ?? "").toString().trim()
  if (parentId) {
    const selfId = (existing?.account_id ?? "").toString()
    if (selfId && parentId === selfId) {
      return "An account cannot be its own parent."
    }
    const [parent] = (await query(
      `SELECT account_id, parent_account_id FROM chart_of_accounts WHERE account_id = ? LIMIT 1`,
      [parentId],
    )) as any[]
    if (!parent) {
      return "The selected parent account does not exist."
    }
    // Walk the parent chain to reject cycles (A → B → A).
    if (selfId) {
      let cursor: string | null = parent.parent_account_id
      let hops = 0
      while (cursor && hops < 100) {
        if (cursor === selfId) {
          return "That parent would create a circular hierarchy."
        }
        const [next] = (await query(
          `SELECT parent_account_id FROM chart_of_accounts WHERE account_id = ? LIMIT 1`,
          [cursor],
        )) as any[]
        cursor = next?.parent_account_id ?? null
        hops++
      }
    }
  }

  return null
}

export type CoaDeletability = { ok: boolean; reason?: string }

/**
 * Decide whether an account can be deleted. Blocks system accounts outright and
 * any account still referenced by a child account, a posted Journal / General
 * Ledger line, or an Expense head. Returns a message explaining the first
 * dependency found so the user knows why the delete was refused.
 */
export async function checkAccountDeletable(row: CoaRow): Promise<CoaDeletability> {
  if (Number(row.is_system) === 1) {
    return {
      ok: false,
      reason:
        "This is a system account used by the posting engine (Sales, Purchase, GST, TDS, Bank, Cash or a control head) and cannot be deleted.",
    }
  }

  const accountId = (row.account_id ?? "").toString()
  if (!accountId) return { ok: true }

  // Count references across the linked ledgers. Each check is wrapped so a table
  // that does not exist in a given environment never blocks the delete.
  const countWhere = async (sql: string, args: any[]): Promise<number> => {
    try {
      const [r] = (await query(sql, args)) as any[]
      return Number(r?.n ?? 0)
    } catch {
      return 0
    }
  }

  const children = await countWhere(
    `SELECT COUNT(*) n FROM chart_of_accounts WHERE parent_account_id = ?`,
    [accountId],
  )
  if (children > 0) {
    return {
      ok: false,
      reason: `This account has ${children} child account${children > 1 ? "s" : ""}. Reassign or delete the children first.`,
    }
  }

  const journalRefs = await countWhere(
    `SELECT COUNT(*) n FROM journal_entries WHERE account_id = ?`,
    [accountId],
  )
  if (journalRefs > 0) {
    return { ok: false, reason: `This account is used in ${journalRefs} journal entr${journalRefs > 1 ? "ies" : "y"} and cannot be deleted.` }
  }

  const ledgerRefs = await countWhere(
    `SELECT COUNT(*) n FROM general_ledger WHERE account_id = ?`,
    [accountId],
  )
  if (ledgerRefs > 0) {
    return { ok: false, reason: `This account has ${ledgerRefs} general ledger posting${ledgerRefs > 1 ? "s" : ""} and cannot be deleted.` }
  }

  const expenseRefs = await countWhere(
    `SELECT COUNT(*) n FROM expenses WHERE account_head_id = ?`,
    [accountId],
  )
  if (expenseRefs > 0) {
    return { ok: false, reason: `This account is set as the expense head on ${expenseRefs} expense${expenseRefs > 1 ? "s" : ""} and cannot be deleted.` }
  }

  return { ok: true }
}
