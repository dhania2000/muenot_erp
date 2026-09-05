import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"

// Columns that clients may send. Derived money fields (taxable_amount,
// *_amount, invoice_total, tds_amount, net_receivable, outstanding_amount,
// payment_status, financial_year) are always recomputed on the server so the
// stored numbers can be trusted regardless of what the browser sends.
const INPUT_FIELDS = [
  "invoice_date", "invoice_type", "financial_year", "client_id", "client_name",
  "project_id", "project_name", "billing_period_from", "billing_period_to",
  "description", "hsn_sac", "quantity", "unit", "rate", "taxable_amount",
  "discount", "cgst_percent", "sgst_percent", "igst_percent", "other_tax_cess",
  "tds_applicable", "tds_section", "tds_rate", "due_date", "amount_received",
  "payment_status", "payment_date", "payment_reference", "irn_reference",
  "eway_bill_no", "credit_debit_note_ref", "notes", "invoice_status",
]

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Indian financial year (April–March) derived from an invoice date. */
function financialYearFor(dateStr?: string | null) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** Recompute every derived money field from the raw inputs. */
function computeDerived(body: Record<string, any>) {
  const quantity = num(body.quantity)
  const rate = num(body.rate)
  const discount = num(body.discount)
  const base = quantity > 0 && rate > 0 ? quantity * rate : num(body.taxable_amount) + discount
  const taxable = round2(Math.max(base - discount, 0))

  const cgstPct = num(body.cgst_percent)
  const sgstPct = num(body.sgst_percent)
  const igstPct = num(body.igst_percent)
  const cgstAmount = round2((taxable * cgstPct) / 100)
  const sgstAmount = round2((taxable * sgstPct) / 100)
  const igstAmount = round2((taxable * igstPct) / 100)
  const otherCess = round2(num(body.other_tax_cess))

  const invoiceTotal = round2(taxable + cgstAmount + sgstAmount + igstAmount + otherCess)

  const tdsApplicable = body.tds_applicable ? 1 : 0
  const tdsRate = num(body.tds_rate)
  const tdsAmount = tdsApplicable ? round2((taxable * tdsRate) / 100) : 0
  const netReceivable = round2(invoiceTotal - tdsAmount)

  const amountReceived = round2(num(body.amount_received))
  const outstanding = round2(netReceivable - amountReceived)

  let paymentStatus = body.payment_status
  if (!paymentStatus) {
    if (amountReceived <= 0) paymentStatus = "Unpaid"
    else if (amountReceived >= netReceivable) paymentStatus = "Paid"
    else paymentStatus = "Partially Paid"
  }

  return {
    quantity, rate, discount,
    taxable_amount: taxable,
    cgst_percent: cgstPct, cgst_amount: cgstAmount,
    sgst_percent: sgstPct, sgst_amount: sgstAmount,
    igst_percent: igstPct, igst_amount: igstAmount,
    other_tax_cess: otherCess,
    invoice_total: invoiceTotal,
    tds_applicable: tdsApplicable,
    tds_rate: tdsRate,
    tds_amount: tdsAmount,
    net_receivable: netReceivable,
    amount_received: amountReceived,
    outstanding_amount: outstanding,
    payment_status: paymentStatus,
    financial_year: body.financial_year || financialYearFor(body.invoice_date),
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams
  const conditions: string[] = []
  const args: any[] = []
  const add = (cond: string, val: any) => { conditions.push(cond); args.push(val) }

  if (p.get("date_from")) add("i.invoice_date >= ?", p.get("date_from"))
  if (p.get("date_to")) add("i.invoice_date <= ?", p.get("date_to"))
  if (p.get("year")) add("YEAR(i.invoice_date) = ?", Number(p.get("year")))
  if (p.get("month")) add("MONTH(i.invoice_date) = ?", Number(p.get("month")))
  if (p.get("financial_year")) add("i.financial_year = ?", p.get("financial_year"))
  if (p.get("invoice_status")) add("i.invoice_status = ?", p.get("invoice_status"))
  if (p.get("payment_status")) add("i.payment_status = ?", p.get("payment_status"))
  if (p.get("invoice_type")) add("i.invoice_type = ?", p.get("invoice_type"))
  if (p.get("search")) {
    conditions.push("(i.invoice_id LIKE ? OR i.client_name LIKE ? OR i.project_name LIKE ? OR i.description LIKE ?)")
    const like = `%${p.get("search")}%`
    args.push(like, like, like, like)
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const rows = await query(
    `SELECT i.*, u.name AS created_by_name
       FROM sales_invoices i
       LEFT JOIN users u ON u.id = i.created_by
       ${where}
       ORDER BY i.invoice_date DESC, i.id DESC`,
    args,
  )

  const [summary] = (await query(
    `SELECT COALESCE(SUM(invoice_total),0) total_billed,
            COALESCE(SUM(net_receivable),0) total_receivable,
            COALESCE(SUM(amount_received),0) total_received,
            COALESCE(SUM(outstanding_amount),0) total_outstanding,
            COUNT(*) total_invoices
       FROM sales_invoices i ${where}`,
    args,
  )) as any[]

  const [years, fys, statuses] = await Promise.all([
    query("SELECT DISTINCT YEAR(invoice_date) y FROM sales_invoices WHERE invoice_date IS NOT NULL ORDER BY y DESC") as Promise<any[]>,
    query("SELECT DISTINCT financial_year fy FROM sales_invoices WHERE financial_year IS NOT NULL AND financial_year <> '' ORDER BY fy DESC") as Promise<any[]>,
    query("SELECT DISTINCT invoice_status s FROM sales_invoices WHERE invoice_status IS NOT NULL AND invoice_status <> '' ORDER BY s") as Promise<any[]>,
  ])

  return NextResponse.json({
    rows,
    summary,
    filterOptions: {
      years: years.map((r) => r.y).filter((y) => y != null),
      financialYears: fys.map((r) => r.fy),
      statuses: statuses.map((r) => r.s),
    },
  })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const derived = computeDerived(body)

  // Invoice ID is generated on the server — clients never set it.
  const invoiceId = await nextRecordId("INV")

  const record: Record<string, any> = { invoice_id: invoiceId }
  for (const field of INPUT_FIELDS) {
    if (field in derived) record[field] = (derived as any)[field]
    else if (body[field] !== undefined && body[field] !== "") record[field] = body[field]
  }
  Object.assign(record, derived)
  record.created_by = session.userId

  const cols = Object.keys(record)
  await query(
    `INSERT INTO sales_invoices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => record[c]),
  )

  return NextResponse.json({ ok: true, invoice_id: invoiceId }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Invoice id is required" }, { status: 400 })

  const [existing] = (await query("SELECT * FROM sales_invoices WHERE id = ?", [id])) as any[]
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  // Merge incoming changes over the stored row, then recompute derived fields.
  const merged = { ...existing, ...body }
  const derived = computeDerived(merged)

  const update: Record<string, any> = {}
  for (const field of INPUT_FIELDS) {
    if (field in derived) update[field] = (derived as any)[field]
    else if (body[field] !== undefined) update[field] = body[field]
  }
  Object.assign(update, derived)

  const cols = Object.keys(update)
  await query(
    `UPDATE sales_invoices SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
    [...cols.map((c) => update[c]), id],
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = Number(req.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Invoice id is required" }, { status: 400 })
  await query("DELETE FROM sales_invoices WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
