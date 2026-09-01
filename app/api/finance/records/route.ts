import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { FINANCE_MODULE_KEYS, financeModulePrefix } from "@/lib/finance-modules"

const modules = new Set(FINANCE_MODULE_KEYS)
const fields = ["module_key","reference_no","record_date","party_name","account_name","record_type","amount","debit","credit","status","reconciliation_status","description"]

export async function GET(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const key = req.nextUrl.searchParams.get("module")
  if (key && !modules.has(key)) return NextResponse.json({ error: "Invalid module" }, { status: 400 })

  const dateFrom = req.nextUrl.searchParams.get("date_from")
  const dateTo = req.nextUrl.searchParams.get("date_to")
  const year = req.nextUrl.searchParams.get("year")
  const month = req.nextUrl.searchParams.get("month")
  const status = req.nextUrl.searchParams.get("status")
  const reconciliationStatus = req.nextUrl.searchParams.get("reconciliation_status")
  const recordType = req.nextUrl.searchParams.get("record_type")
  const search = req.nextUrl.searchParams.get("search")

  const conditions: string[] = []
  const args: any[] = []
  if (key) { conditions.push("module_key = ?"); args.push(key) }
  if (dateFrom) { conditions.push("record_date >= ?"); args.push(dateFrom) }
  if (dateTo) { conditions.push("record_date <= ?"); args.push(dateTo) }
  if (year) { conditions.push("YEAR(record_date) = ?"); args.push(Number(year)) }
  if (month) { conditions.push("MONTH(record_date) = ?"); args.push(Number(month)) }
  if (status) { conditions.push("status = ?"); args.push(status) }
  if (reconciliationStatus) { conditions.push("reconciliation_status = ?"); args.push(reconciliationStatus) }
  if (recordType) { conditions.push("record_type = ?"); args.push(recordType) }
  if (search) {
    conditions.push("(reference_no LIKE ? OR party_name LIKE ? OR account_name LIKE ? OR record_type LIKE ? OR description LIKE ?)")
    args.push(...Array.from({ length: 5 }, () => `%${search}%`))
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const rows = await query(`SELECT * FROM finance_records ${where} ORDER BY record_date DESC, record_id DESC`, args)
  const [summary] = await query(
    `SELECT COALESCE(SUM(amount),0) total_amount, COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COUNT(*) total_records FROM finance_records ${where}`,
    args,
  ) as any[]

  // Filter option lists always reflect the full module dataset (not the
  // currently applied filters) so dropdowns don't shrink as the user filters.
  let filterOptions = { years: [] as number[], statuses: [] as string[], types: [] as string[] }
  if (key) {
    const [years, statuses, types] = await Promise.all([
      query("SELECT DISTINCT YEAR(record_date) y FROM finance_records WHERE module_key = ? AND record_date IS NOT NULL ORDER BY y DESC", [key]) as Promise<any[]>,
      query("SELECT DISTINCT status s FROM finance_records WHERE module_key = ? AND status IS NOT NULL AND status <> '' ORDER BY s", [key]) as Promise<any[]>,
      query("SELECT DISTINCT record_type t FROM finance_records WHERE module_key = ? AND record_type IS NOT NULL AND record_type <> '' ORDER BY t", [key]) as Promise<any[]>,
    ])
    filterOptions = {
      years: years.map((r) => r.y).filter((y) => y != null),
      statuses: statuses.map((r) => r.s),
      types: types.map((r) => r.t),
    }
  }

  return NextResponse.json({ rows, summary, filterOptions })
}

export async function POST(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json(); if (!modules.has(body.module_key)) return NextResponse.json({ error: "Invalid module" }, { status: 400 })
  const insertFields = fields.filter((field) => body[field] !== undefined && field !== "reference_no")
  if (!insertFields.includes("module_key")) return NextResponse.json({ error: "Module is required" }, { status: 400 })
  insertFields.push("reference_no")
  const referenceNo = await nextRecordId(financeModulePrefix(body.module_key))
  await query(`INSERT INTO finance_records (${insertFields.join(",")}, created_by) VALUES (${insertFields.map(() => "?").join(",")}, ?)`, [...insertFields.map((field) => field === "reference_no" ? referenceNo : body[field]), session.userId])
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json(); const id = Number(body.record_id); if (!id) return NextResponse.json({ error: "Record ID is required" }, { status: 400 })
  const updateFields = fields.filter((field) => field !== "module_key" && body[field] !== undefined)
  if (!updateFields.length) return NextResponse.json({ error: "No fields" }, { status: 400 })
  await query(`UPDATE finance_records SET ${updateFields.map((field) => `${field}=?`).join(",")} WHERE record_id=?`, [...updateFields.map((field) => body[field]), id])
  return NextResponse.json({ ok: true })
}
