import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import { parseSpreadsheetDate } from "@/lib/excel-import"
import {
  listPostableAccounts,
  createManualJournal,
  type ManualJournalLineInput,
} from "@/lib/finance-journal"

export const runtime = "nodejs"

const PERMISSION_KEY = "finance.journal"

// ---------------------------------------------------------------------------
// Phase 49/50 — bulk journal importer that ROUTES THROUGH the accounting engine.
//
// Unlike the generic config-driven module importer (which inserts rows straight
// into a table), every uploaded row here is a single journal LINE. Lines are
// grouped into vouchers by the "Voucher" column, and each voucher is handed to
// createManualJournal — so it goes through the exact same balanced-voucher
// validation, Chart-of-Accounts resolution, party/project + GST/TDS checks and
// closed-period guard as a hand-keyed manual journal, and lands as a Draft for
// review. There is no second accounting path.
// ---------------------------------------------------------------------------

type ImportRow = {
  voucher?: string
  journal_date?: string
  account?: string
  debit?: string
  credit?: string
  narration?: string
  party_id?: string
  project_id?: string
  cost_centre?: string
  reference_no?: string
  voucher_type?: string
  gst?: string
  tds?: string
}

function parseAmount(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0
  const n = Number(String(value).replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : 0
}

const norm = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to create journal entries." }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? (body.rows as ImportRow[]) : []
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })

  // Resolve accounts by code first, then by name, both case-insensitively, so a
  // spreadsheet can reference a head by either its code ("4001") or its name.
  const accounts = await listPostableAccounts()
  const byCode = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const a of accounts) {
    if (a.account_code) byCode.set(norm(a.account_code), String(a.account_id))
    if (a.account_name) byName.set(norm(a.account_name), String(a.account_id))
  }
  const resolveAccount = (raw: string): string | null => {
    const key = norm(raw)
    return byCode.get(key) ?? byName.get(key) ?? null
  }

  // Group rows into vouchers in first-seen order. Rows without an explicit
  // Voucher value each become their own single-line group (which will then fail
  // the "needs two lines" balance check and be reported, rather than silently
  // merged into someone else's voucher).
  type Group = {
    key: string
    label: string
    journalDate: string
    voucherType: string
    referenceNo: string
    narration: string
    lines: ManualJournalLineInput[]
    rowNumbers: number[]
    error?: string
  }
  const groups = new Map<string, Group>()
  const order: string[] = []

  rows.forEach((row, index) => {
    const rowNo = index + 2 // account for the header row in messages
    const voucherLabel = String(row.voucher ?? "").trim()
    const key = voucherLabel || `__row_${index}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        label: voucherLabel || `(row ${rowNo})`,
        journalDate: "",
        voucherType: String(row.voucher_type ?? "").trim() || "Journal",
        referenceNo: String(row.reference_no ?? "").trim(),
        narration: String(row.narration ?? "").trim(),
        lines: [],
        rowNumbers: [],
      }
      groups.set(key, g)
      order.push(key)
    }
    g.rowNumbers.push(rowNo)

    // Header fields take the first non-empty value seen across the voucher.
    if (!g.journalDate) {
      const d = parseSpreadsheetDate(String(row.journal_date ?? ""))
      if (d) g.journalDate = d
    }
    if (!g.referenceNo && row.reference_no) g.referenceNo = String(row.reference_no).trim()
    if (!g.narration && row.narration) g.narration = String(row.narration).trim()

    const accountRaw = String(row.account ?? "").trim()
    const accountId = accountRaw ? resolveAccount(accountRaw) : null
    if (accountRaw && !accountId && !g.error) {
      g.error = `Row ${rowNo}: account "${accountRaw}" was not found in the Chart of Accounts.`
    }

    g.lines.push({
      accountId: accountId ?? "",
      debit: parseAmount(row.debit),
      credit: parseAmount(row.credit),
      narration: String(row.narration ?? "").trim() || null,
      partyId: String(row.party_id ?? "").trim() || null,
      projectId: String(row.project_id ?? "").trim() || null,
      costCentre: String(row.cost_centre ?? "").trim() || null,
      gst: parseAmount(row.gst),
      tds: parseAmount(row.tds),
    })
  })

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const created: string[] = []

  for (const key of order) {
    const g = groups.get(key)!
    const where = g.label
    if (g.error) {
      failed++
      errors.push(`Voucher ${where}: ${g.error.replace(/^Row \d+: /, "")}`)
      continue
    }
    if (!g.journalDate) {
      failed++
      errors.push(`Voucher ${where}: no valid journal date on any of its rows.`)
      continue
    }
    try {
      const result = await createManualJournal(
        {
          journalDate: g.journalDate,
          voucherType: g.voucherType,
          referenceNo: g.referenceNo || null,
          narration: g.narration || null,
          lines: g.lines,
        },
        { createdBy: session.userId, actorName: session.name ?? null },
      )
      imported++
      created.push(result.journalId)
    } catch (error) {
      failed++
      errors.push(`Voucher ${where}: ${(error as Error)?.message || "could not be imported."}`)
    }
  }

  return NextResponse.json({ imported, failed, created, errors: errors.slice(0, 30) })
}
