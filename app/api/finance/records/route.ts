import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"

const modules = new Set(["sales-invoices","purchase-bills","expenses","fte-invoices","freelance-invoices","bank-transactions","bank-cash","chart-of-accounts","customers-vendors"])
const fields = ["module_key","reference_no","record_date","party_name","account_name","record_type","amount","debit","credit","status","reconciliation_status","description"]

export async function GET(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const key = req.nextUrl.searchParams.get("module")
  if (key && !modules.has(key)) return NextResponse.json({ error: "Invalid module" }, { status: 400 })
  const where = key ? "WHERE module_key = ?" : ""
  const args = key ? [key] : []
  const rows = await query(`SELECT * FROM finance_records ${where} ORDER BY record_date DESC, record_id DESC`, args)
  const [summary] = await query("SELECT COALESCE(SUM(amount),0) total_amount, COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COUNT(*) total_records FROM finance_records") as any[]
  return NextResponse.json({ rows, summary })
}

export async function POST(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json(); if (!modules.has(body.module_key)) return NextResponse.json({ error: "Invalid module" }, { status: 400 })
  const insertFields = fields.filter((field) => body[field] !== undefined && field !== "reference_no")
  if (!insertFields.includes("module_key")) return NextResponse.json({ error: "Module is required" }, { status: 400 })
  insertFields.push("reference_no")
  const prefix = body.module_key === "sales-invoices" ? "INV" : "FIN"
  const referenceNo = await nextRecordId(prefix)
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
