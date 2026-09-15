import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import {
  journalExportDataset,
  JOURNAL_EXPORT_KINDS,
  JOURNAL_EXPORT_LABELS,
  type JournalExportKind,
  type JournalExportFilters,
} from "@/lib/finance-journal-export"

export const runtime = "nodejs"

const MODULE = "finance.journal"

/**
 * GET /api/finance/journal-entries/export  (Phase 51)
 *   (no kind)                → catalog of the five available datasets
 *   ?kind=register|detail|account|voucher|period → one dataset (columns + rows)
 *
 * Shared filters mirror the Journal Entries screen so an export always matches
 * what the user is looking at:
 *   ?financial_year=2026-27  ?source=all|manual|system  ?search=…  ?from=…  ?to=…
 *
 * Gated by the `export` extended action (fallback: view) so it can be revoked
 * independently of the view right, and never lets a user without journal
 * visibility pull the registers.
 */
export async function GET(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "export")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const params = req.nextUrl.searchParams

  const sourceParam = params.get("source")
  const source: JournalExportFilters["source"] =
    sourceParam === "manual" || sourceParam === "system" ? sourceParam : "all"

  const filters: JournalExportFilters = {
    financialYear: params.get("financial_year"),
    source,
    search: params.get("search"),
    from: params.get("from"),
    to: params.get("to"),
  }

  try {
    const kind = params.get("kind")
    if (kind) {
      if (!JOURNAL_EXPORT_KINDS.includes(kind as JournalExportKind)) {
        return NextResponse.json({ error: `Unknown export dataset: ${kind}` }, { status: 400 })
      }
      return NextResponse.json(await journalExportDataset(kind as JournalExportKind, filters))
    }

    return NextResponse.json({
      datasets: JOURNAL_EXPORT_KINDS.map((k) => ({ key: k, label: JOURNAL_EXPORT_LABELS[k] })),
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
