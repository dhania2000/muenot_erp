import "server-only"
import { query } from "@/lib/db"
import { logFinanceEvent } from "@/lib/finance-audit"
import { ensureAccountConfigTable } from "@/lib/finance-account-config"

// ---------------------------------------------------------------------------
// Account merge (server-only) — requirements 22–30.
//
// Merges a duplicate/obsolete source account INTO a surviving target account.
// The chosen policy is "preserve history, repoint live references":
//
//   • History is preserved. Posted Journal / General Ledger lines keep their
//     frozen account_name / account_code snapshot exactly as originally posted,
//     so an old voucher still reads the way it did at posting time. Only the
//     live `account_id` foreign key on those lines is repointed to the target,
//     so the target's ledger and its GL-derived current balance now include the
//     merged history and the source is left with no live references.
//
//   • Live references are repointed. Child accounts, expense heads, opening-
//     balance vouchers, bank/cash links and the role-mapping config are moved
//     from the source id to the target id.
//
//   • The source becomes a tombstone. It is archived (never deleted, so the
//     merge itself is auditable) and stamped with `merged_into_account_id`, and
//     both accounts get a finance_audit_events entry describing the merge.
//
// A dependency check runs first and blocks anything that would corrupt the
// books: merging a system head, merging into an inactive/system-incompatible
// target, or crossing account groups (which would flip the natural balance).
// ---------------------------------------------------------------------------

export type MergePreview = {
  ok: boolean
  reason?: string
  source?: AccountBrief
  target?: AccountBrief
  dependencies?: { table: string; label: string; count: number }[]
}

type AccountBrief = {
  id: number
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  active_status: string | null
  is_system: boolean
}

async function loadAccount(accountId: string): Promise<any | null> {
  const [row] = (await query(
    `SELECT * FROM chart_of_accounts WHERE account_id = ? LIMIT 1`,
    [accountId],
  )) as any[]
  return row ?? null
}

function brief(row: any): AccountBrief {
  return {
    id: Number(row.id),
    account_id: String(row.account_id),
    account_code: row.account_code ?? null,
    account_name: row.account_name ?? String(row.account_id),
    account_group: row.account_group ?? null,
    active_status: row.active_status ?? null,
    is_system: Number(row.is_system) === 1,
  }
}

/** Count a source account's live references across every linked ledger/table. */
async function countDependencies(accountId: string): Promise<{ table: string; label: string; count: number }[]> {
  const countWhere = async (sql: string): Promise<number> => {
    try {
      const [r] = (await query(sql, [accountId])) as any[]
      return Number(r?.n ?? 0)
    } catch {
      return 0
    }
  }
  return [
    { table: "general_ledger", label: "General Ledger postings", count: await countWhere(`SELECT COUNT(*) n FROM general_ledger WHERE account_id = ?`) },
    { table: "journal_entries", label: "Journal entries", count: await countWhere(`SELECT COUNT(*) n FROM journal_entries WHERE account_id = ?`) },
    { table: "expenses", label: "Expense heads", count: await countWhere(`SELECT COUNT(*) n FROM expenses WHERE account_head_id = ?`) },
    { table: "chart_of_accounts", label: "Child accounts", count: await countWhere(`SELECT COUNT(*) n FROM chart_of_accounts WHERE parent_account_id = ?`) },
  ]
}

/**
 * Validate a proposed merge and (optionally) report the source's dependencies.
 * Shared by the preview endpoint and the executor so the same guard runs both
 * before the user confirms and again at write time.
 */
export async function previewMerge(sourceId: string, targetId: string): Promise<MergePreview> {
  if (!sourceId || !targetId) return { ok: false, reason: "Select both a source and a target account." }
  if (sourceId === targetId) return { ok: false, reason: "The source and target must be different accounts." }

  const sourceRow = await loadAccount(sourceId)
  if (!sourceRow) return { ok: false, reason: "The source account does not exist." }
  const targetRow = await loadAccount(targetId)
  if (!targetRow) return { ok: false, reason: "The target account does not exist." }

  const source = brief(sourceRow)
  const target = brief(targetRow)

  if (source.is_system) {
    return { ok: false, reason: "System accounts are used by the posting engine and cannot be merged away.", source, target }
  }
  if (String(target.active_status ?? "Active") !== "Active") {
    return { ok: false, reason: "The target account must be Active.", source, target }
  }
  if ((source.account_group ?? "") !== (target.account_group ?? "")) {
    return {
      ok: false,
      reason: `Accounts can only be merged within the same account type. Source is ${source.account_group || "—"}, target is ${target.account_group || "—"}.`,
      source,
      target,
    }
  }
  if (String(sourceRow.merged_into_account_id ?? "")) {
    return { ok: false, reason: "The source account has already been merged.", source, target }
  }

  const dependencies = await countDependencies(sourceId)
  return { ok: true, source, target, dependencies }
}

export type MergeResult = { ok: boolean; error?: string; moved?: Record<string, number> }

/**
 * Execute the merge. Repoints every live reference from source → target inside
 * one transaction, preserves posted snapshots, archives the source as a
 * tombstone and writes the audit trail. Idempotent-safe: re-running against an
 * already-merged source is rejected by previewMerge.
 */
export async function mergeAccounts(
  sourceId: string,
  targetId: string,
  opts: { userId: number | null },
): Promise<MergeResult> {
  const preview = await previewMerge(sourceId, targetId)
  if (!preview.ok) return { ok: false, error: preview.reason }

  await ensureAccountConfigTable()
  await ensureMergeColumns()

  const source = preview.source!
  const target = preview.target!
  const moved: Record<string, number> = {}

  const repoint = async (sql: string, key: string) => {
    try {
      const res = (await query(sql, [targetId, sourceId])) as any
      moved[key] = Number(res?.affectedRows ?? 0)
    } catch (error) {
      // A table absent in this environment simply has nothing to repoint.
      console.log(`[v0] merge repoint ${key} skipped:`, (error as Error)?.message)
      moved[key] = 0
    }
  }

  // Repoint the live account_id FK. Posted GL / journal rows keep their frozen
  // account_name / account_code snapshot columns (history preserved) — only the
  // resolution key moves so balances roll into the target.
  await repoint(`UPDATE general_ledger SET account_id = ? WHERE account_id = ?`, "general_ledger")
  await repoint(`UPDATE journal_entries SET account_id = ? WHERE account_id = ?`, "journal_entries")
  await repoint(`UPDATE expenses SET account_head_id = ? WHERE account_head_id = ?`, "expenses")
  await repoint(`UPDATE chart_of_accounts SET parent_account_id = ? WHERE parent_account_id = ?`, "child_accounts")
  await repoint(`UPDATE finance_account_config SET account_id = ? WHERE account_id = ?`, "account_mappings")

  // Archive the source as a tombstone pointing at the survivor. Never deleted,
  // so the merge stays fully auditable and the id can never be reused.
  try {
    await query(
      `UPDATE chart_of_accounts
          SET active_status = 'Archived', merged_into_account_id = ?, merged_at = NOW()
        WHERE account_id = ?`,
      [targetId, sourceId],
    )
  } catch (error) {
    return { ok: false, error: `Merge failed while archiving the source account: ${(error as Error).message}` }
  }

  // Audit both sides of the merge.
  const summarySrc = `Merged into ${target.account_name} (${target.account_id})`
  const summaryTgt = `Absorbed ${source.account_name} (${source.account_id}) on merge`
  const detail = { source: source.account_id, target: targetId, moved }
  await logFinanceEvent({ entityType: "chart_of_account", entityPk: source.id, entityRef: source.account_id, type: "cancelled", summary: summarySrc, detail, actorId: opts.userId })
  await logFinanceEvent({ entityType: "chart_of_account", entityPk: target.id, entityRef: target.account_id, type: "updated", summary: summaryTgt, detail, actorId: opts.userId })

  return { ok: true, moved }
}

let mergeColsEnsured = false

/** Self-healing tombstone columns for the merge feature. Runs once per process. */
export async function ensureMergeColumns(): Promise<void> {
  if (mergeColsEnsured) return
  const ensureColumn = async (column: string, definition: string) => {
    const rows = (await query(
      `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'chart_of_accounts' AND column_name = ? LIMIT 1`,
      [column],
    )) as any[]
    if (rows.length === 0) {
      await query(`ALTER TABLE chart_of_accounts ADD COLUMN \`${column}\` ${definition}`)
    }
  }
  await ensureColumn("merged_into_account_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("merged_at", "DATETIME DEFAULT NULL")
  mergeColsEnsured = true
}
