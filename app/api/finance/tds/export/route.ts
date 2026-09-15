import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import {
  tdsExportDataset,
  tdsCaPackage,
  TDS_EXPORT_KINDS,
  TDS_EXPORT_LABELS,
  type TdsExportKind,
} from "@/lib/finance-tds-export"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const MODULE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "employee") return "employee"
  if (s === "receivable") return "receivable"
  return "payable"
}

/**
 * GET /api/finance/tds/export
 *   ?fy=2026-27&direction=payable                → catalog of available datasets
 *   ?fy=…&direction=…&kind=challan               → a single dataset (columns + rows)
 *   ?fy=…&direction=…&ca=1                        → the full CA review package
 *
 * Gated by the `export_return` extended action so a plain Update can never pull
 * the statutory registers or the CA hand-off pack.
 */
export async function GET(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "export_return")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const params = req.nextUrl.searchParams
  const fy = params.get("fy")
  const direction = dirOf(params.get("direction"))
  if (!fy) return NextResponse.json({ error: "Financial year (fy) is required." }, { status: 400 })

  try {
    if (params.get("ca") === "1") {
      return NextResponse.json(await tdsCaPackage(fy, direction))
    }

    const kind = params.get("kind")
    if (kind) {
      if (!TDS_EXPORT_KINDS.includes(kind as TdsExportKind)) {
        return NextResponse.json({ error: `Unknown export dataset: ${kind}` }, { status: 400 })
      }
      return NextResponse.json(await tdsExportDataset(kind as TdsExportKind, fy, direction))
    }

    // Default: the catalog of dataset kinds available for this FY + direction.
    return NextResponse.json({
      financial_year: fy,
      direction,
      datasets: TDS_EXPORT_KINDS.map((k) => ({ key: k, label: TDS_EXPORT_LABELS[k] })),
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
