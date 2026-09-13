import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextDocumentId } from "@/lib/settings/numbering"
import { getSettings } from "@/lib/settings/server"
import { ensureSalesInvoiceSchema } from "@/lib/sales-invoice-db"
import {
  computeItem,
  computeHeaderFromItems,
  recomputePayment,
  resolveSupplyType,
  stateCodeFromGstin,
  taxAllowedForType,
  type InvoiceItemInput,
} from "@/lib/sales-invoice-compute"
import { postSalesInvoice } from "@/lib/finance-posting"
import { logFinanceEvent, getFinanceEvents } from "@/lib/finance-audit"
import { runSourceChecks } from "@/lib/sales-invoice-sources"

// Invoice types that must never post real AR/revenue to the ledger.
const NON_POSTING_TYPES = new Set(["Proforma Invoice"])
// Credit Note reverses (unwinds) the original posting; everything else posts normally.
const isCreditNote = (t?: string | null) => String(t || "") === "Credit Note"
const isNoteType = (t?: string | null) => t === "Credit Note" || t === "Debit Note"

/** Source of the invoice (spec 32–33), derived from the strongest link present. */
function deriveSourceType(body: Record<string, any>): string {
  if (body.source_type && body.source_type !== "Manual") return body.source_type
  if (isNoteType(body.invoice_type)) return "Other"
  if (body.milestone_id) return "Milestone"
  if (body.contract_id) return "Contract"
  if (body.quotation_id) return "Quotation"
  if (body.project_id) return "Project"
  return body.source_type || "Manual"
}

// Header columns a client may set. Every derived money field is recomputed on
// the server from the line items, so those are never trusted from the browser.
const INPUT_FIELDS = [
  "invoice_date", "invoice_type", "financial_year", "client_id", "client_name",
  "customer_party_id", "contract_id", "quotation_id", "milestone_id", "source_type",
  "original_invoice_id", "project_id", "project_name", "billing_period_from",
  "billing_period_to", "description", "hsn_sac", "unit",
  "place_of_supply", "place_of_supply_code", "supply_type",
  "tds_applicable", "tds_section", "tds_rate", "due_date", "amount_received",
  "payment_status", "payment_date", "payment_reference", "irn_reference",
  "eway_bill_no", "credit_debit_note_ref", "notes", "invoice_status",
]

// Fields that may still change once an invoice has left Draft. Amounts, items,
// party and tax treatment are frozen — only payment tracking, compliance refs
// and controlled status transitions remain editable.
const POST_ISSUE_EDITABLE = new Set([
  "amount_received", "payment_status", "payment_date", "payment_reference",
  "irn_reference", "eway_bill_no", "notes", "invoice_status",
])
// Once posted, only cash application remains.
const POSTED_EDITABLE = new Set([
  "amount_received", "payment_status", "payment_date", "payment_reference",
])

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const FY_MONTH: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

function financialYearFor(dateStr?: string | null, startMonth = 3) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= startMonth ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** Legacy single-line payloads (no items[]) are normalised into one line item. */
function itemsFromBody(body: Record<string, any>): InvoiceItemInput[] {
  if (Array.isArray(body.items) && body.items.length > 0) {
    return body.items.filter((it: any) => it && (num(it.quantity) > 0 || num(it.rate) > 0 || it.description))
  }
  // Back-compat: derive a single line from the old flat header fields.
  const gstRate = num(body.cgst_percent) + num(body.sgst_percent) + num(body.igst_percent)
  const qty = num(body.quantity)
  const rate = num(body.rate)
  const taxable = num(body.taxable_amount)
  return [
    {
      description: body.description ?? null,
      hsn_sac: body.hsn_sac ?? null,
      quantity: qty > 0 ? qty : 1,
      unit: body.unit ?? null,
      rate: rate > 0 ? rate : taxable,
      discount_type: "amount",
      discount_value: num(body.discount),
      tax_rate: gstRate,
      cess_amount: num(body.other_tax_cess),
    },
  ]
}

/** Resolve the buyer state code from place-of-supply, else the client GSTIN. */
async function resolveBuyerStateCode(body: Record<string, any>): Promise<string | null> {
  if (body.place_of_supply_code) return String(body.place_of_supply_code).slice(0, 2)
  const clientRef = body.client_id || body.client_name
  if (!clientRef) return null
  try {
    const rows = (await query(
      `SELECT gst_number, state FROM clients WHERE client_code = ? OR client_name = ? LIMIT 1`,
      [body.client_id || "", body.client_name || ""],
    )) as any[]
    return stateCodeFromGstin(rows?.[0]?.gst_number)
  } catch {
    return null
  }
}

/**
 * Business-rule gate shared by create + draft-edit. Returns a NextResponse to
 * abort with, or null to proceed. Blocking conditions (over-billing, duplicate
 * period) can be waived with an authorized override flag, which is audited.
 */
async function businessRuleError(
  body: Record<string, any>,
  invoiceTotal: number,
  excludeInvoicePk?: number,
): Promise<NextResponse | null> {
  // Billing period sanity (spec 24).
  if (body.billing_period_from && body.billing_period_to && body.billing_period_to < body.billing_period_from) {
    return NextResponse.json({ error: "Billing period end must be on or after the start date." }, { status: 400 })
  }

  // Credit / Debit notes must reference a real original invoice (spec 36–37).
  if (isNoteType(body.invoice_type)) {
    if (!body.original_invoice_id) {
      return NextResponse.json({ error: `${body.invoice_type} must reference the original invoice.` }, { status: 400 })
    }
    const [orig] = (await query(
      `SELECT id FROM sales_invoices WHERE invoice_id = ? OR id = ? LIMIT 1`,
      [body.original_invoice_id, Number(body.original_invoice_id) || 0],
    )) as any[]
    if (!orig) {
      return NextResponse.json({ error: "Referenced original invoice was not found." }, { status: 400 })
    }
  }

  const checks = await runSourceChecks({
    clientName: body.client_name,
    contractId: body.contract_id || undefined,
    quotationId: body.quotation_id || undefined,
    projectId: body.project_id || undefined,
    milestoneId: body.milestone_id || undefined,
    invoiceType: body.invoice_type,
    attemptedTotal: invoiceTotal,
    billingFrom: body.billing_period_from || undefined,
    billingTo: body.billing_period_to || undefined,
    excludeInvoicePk,
  })

  // Consistency mismatches always block (spec 29–31).
  if (checks.consistency) {
    return NextResponse.json({ error: checks.consistency, check: checks }, { status: 409 })
  }
  // Over-billing blocks unless explicitly overridden (spec 20).
  if (checks.overbilling && !body.allow_overbilling) {
    const o = checks.overbilling
    return NextResponse.json(
      {
        error: `Over-billing: only ${o.remaining} remains billable on this ${o.kind} (billed ${o.invoiced} of ${o.billable}). This invoice adds ${o.attempted}. Confirm override to continue.`,
        requiresOverride: "overbilling",
        check: checks,
      },
      { status: 409 },
    )
  }
  // Duplicate billing period blocks unless overridden (spec 25–26).
  if (checks.duplicate && !body.allow_duplicate) {
    return NextResponse.json(
      {
        error: `A non-cancelled invoice (${checks.duplicate.invoice_id}) already covers this billing period for the same source. Confirm override to continue.`,
        requiresOverride: "duplicate",
        check: checks,
      },
      { status: 409 },
    )
  }
  return null
}

/** Resolve stored source ids into human codes for the "why was this invoiced" chain (spec 32). */
async function resolveSourceChain(inv: Record<string, any>) {
  const chain: {
    source_type: string
    quotation?: string | null
    contract?: string | null
    project?: string | null
    original_invoice?: string | null
    client?: string | null
  } = { source_type: inv.source_type || "Manual", client: inv.client_name || inv.client_id || null }

  const grab = async (sql: string, id: any) => {
    if (!id) return null
    try {
      const [r] = (await query(sql, [id])) as any[]
      return r ? Object.values(r)[0] : null
    } catch {
      return null
    }
  }

  chain.contract = (await grab(`SELECT contract_code FROM sales_contracts WHERE id = ? LIMIT 1`, inv.contract_id)) as any
  chain.quotation = (await grab(`SELECT quote_code FROM sales_quotations WHERE id = ? LIMIT 1`, inv.quotation_id)) as any
  chain.project = (await grab(`SELECT project_name FROM operations_projects WHERE id = ? LIMIT 1`, inv.project_id)) as any
  if (inv.original_invoice_id) {
    try {
      const [r] = (await query(
        `SELECT invoice_id FROM sales_invoices WHERE invoice_id = ? OR id = ? LIMIT 1`,
        [inv.original_invoice_id, Number(inv.original_invoice_id) || 0],
      )) as any[]
      chain.original_invoice = r?.invoice_id || inv.original_invoice_id
    } catch {
      chain.original_invoice = inv.original_invoice_id
    }
  }
  return chain
}

async function loadItems(invoicePk: number) {
  return (await query(
    `SELECT * FROM sales_invoice_items WHERE invoice_pk = ? ORDER BY line_no ASC, id ASC`,
    [invoicePk],
  )) as any[]
}

async function replaceItems(invoicePk: number, items: ReturnType<typeof computeItem>[]) {
  await query(`DELETE FROM sales_invoice_items WHERE invoice_pk = ?`, [invoicePk])
  for (const it of items) {
    const record = { invoice_pk: invoicePk, ...it }
    const cols = Object.keys(record)
    await query(
      `INSERT INTO sales_invoice_items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => (record as any)[c]),
    )
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSalesInvoiceSchema()

  const p = req.nextUrl.searchParams

  // Single invoice + its line items (used by the edit dialog). When
  // include=ledger the posted voucher (journal + general ledger) and the audit
  // trail are attached so a detail view can show the accounting behind it.
  const idParam = p.get("id")
  if (idParam) {
    const pk = Number(idParam)
    const [inv] = (await query(`SELECT * FROM sales_invoices WHERE id = ? LIMIT 1`, [pk])) as any[]
    if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
    const items = await loadItems(inv.id)
    const sourceChain = await resolveSourceChain(inv)
    if (p.get("include") === "ledger") {
      const [journal, ledger, audit] = await Promise.all([
        query(
          `SELECT * FROM journal_entries WHERE source_entity_type = 'sales_invoice' AND source_entity_id = ? ORDER BY id ASC`,
          [pk],
        ),
        query(
          `SELECT * FROM general_ledger WHERE source_entity_type = 'sales_invoice' AND source_entity_id = ? ORDER BY id ASC`,
          [pk],
        ),
        getFinanceEvents("sales_invoice", pk),
      ])
      return NextResponse.json({ invoice: inv, items, journal, ledger, audit, sourceChain })
    }
    return NextResponse.json({ invoice: inv, items, sourceChain })
  }

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
  await ensureSalesInvoiceSchema()

  const body = await req.json()
  const settings = await getSettings()
  const fyStartMonth = FY_MONTH[settings["app.financial_year_start"]] ?? 3

  // Idempotency: a retried create with the same key returns the original row
  // instead of inserting a duplicate financial record.
  const idempotencyKey = req.headers.get("idempotency-key") || body.idempotency_key || null
  if (idempotencyKey) {
    const [dupe] = (await query(
      `SELECT id, invoice_id FROM sales_invoices WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
    )) as any[]
    if (dupe) return NextResponse.json({ ok: true, id: dupe.id, invoice_id: dupe.invoice_id, deduped: true }, { status: 200 })
  }

  // Payment-terms hierarchy for the due date: invoice override → client terms →
  // finance default. (Contract terms slot in at the auto-fill layer.)
  if (!body.due_date && body.invoice_date) {
    const dueDays = Number(settings["finance.due_days"]) || 15
    const d = new Date(body.invoice_date)
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + dueDays)
      body.due_date = d.toISOString().slice(0, 10)
    }
  }
  if ((body.notes == null || body.notes === "") && settings["finance.invoice_terms"]) {
    body.notes = settings["finance.invoice_terms"]
  }

  // Seller GST snapshot + place-of-supply → supply type.
  const sellerGstin = settings["address.tax_number"] || ""
  const sellerStateCode = stateCodeFromGstin(sellerGstin)
  const buyerStateCode = await resolveBuyerStateCode(body)
  const supplyType = resolveSupplyType({ override: body.supply_type, sellerStateCode, buyerStateCode })
  const taxEnabled = taxAllowedForType(body.invoice_type)

  const items = itemsFromBody(body).map((line, i) => computeItem(line, i, supplyType, taxEnabled))
  if (items.length === 0) return NextResponse.json({ error: "At least one line item is required" }, { status: 400 })

  const header = computeHeaderFromItems(items, {
    tds_applicable: body.tds_applicable,
    tds_rate: body.tds_rate,
    amount_received: body.amount_received,
    payment_status: body.payment_status,
  })

  // Proforma invoices are non-posting by definition (spec 35).
  if (NON_POSTING_TYPES.has(body.invoice_type) && body.invoice_status === "Posted") {
    return NextResponse.json({ error: "Proforma invoices cannot be posted to the ledger." }, { status: 409 })
  }

  const ruleError = await businessRuleError(body, header.invoice_total)
  if (ruleError) return ruleError

  const invoiceId = await nextDocumentId("invoice")
  const first = items[0]

  const record: Record<string, any> = { invoice_id: invoiceId }
  for (const field of INPUT_FIELDS) {
    if (body[field] !== undefined && body[field] !== "") record[field] = body[field]
  }
  // Server-authoritative fields override anything the client sent.
  Object.assign(record, {
    financial_year: body.financial_year || financialYearFor(body.invoice_date, fyStartMonth),
    seller_gstin: sellerGstin || null,
    seller_state_code: sellerStateCode,
    place_of_supply_code: body.place_of_supply_code || buyerStateCode || null,
    supply_type: supplyType,
    source_type: deriveSourceType(body),
    tds_applicable: body.tds_applicable ? 1 : 0,
    tds_rate: num(body.tds_rate),
    // Header mirrors of the first line + aggregates keep the PDF / list working.
    hsn_sac: first.hsn_sac,
    quantity: first.quantity,
    unit: first.unit,
    rate: first.rate,
    discount: header.discount,
    taxable_amount: header.taxable_amount,
    cgst_percent: header.cgst_percent, cgst_amount: header.cgst_amount,
    sgst_percent: header.sgst_percent, sgst_amount: header.sgst_amount,
    igst_percent: header.igst_percent, igst_amount: header.igst_amount,
    other_tax_cess: header.other_tax_cess,
    invoice_total: header.invoice_total,
    tds_amount: header.tds_amount,
    net_receivable: header.net_receivable,
    amount_received: header.amount_received,
    outstanding_amount: header.outstanding_amount,
    payment_status: header.payment_status,
    invoice_status: body.invoice_status || "Draft",
    idempotency_key: idempotencyKey,
    created_by: session.userId,
  })

  const cols = Object.keys(record)
  const result = (await query(
    `INSERT INTO sales_invoices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => record[c]),
  )) as any
  const invoicePk = Number(result?.insertId)
  await replaceItems(invoicePk, items)

  await logFinanceEvent({
    entityType: "sales_invoice",
    entityPk: invoicePk,
    entityRef: invoiceId,
    type: "created",
    summary: `Invoice ${invoiceId} created as ${record.invoice_status}`,
    amount: header.invoice_total,
    detail: { client_name: record.client_name ?? null, status: record.invoice_status },
    actorId: session.userId,
  })

  if (body.allow_overbilling || body.allow_duplicate) {
    await logFinanceEvent({
      entityType: "sales_invoice",
      entityPk: invoicePk,
      entityRef: invoiceId,
      type: "override",
      summary: `Authorized override on ${invoiceId}: ${[body.allow_overbilling && "over-billing", body.allow_duplicate && "duplicate period"].filter(Boolean).join(", ")}`,
      actorId: session.userId,
    })
  }

  // A brand-new invoice created straight into Posted state is posted to the
  // ledger immediately (same rules as the PATCH transition).
  if (record.invoice_status === "Posted") {
    try {
      const [full] = (await query("SELECT * FROM sales_invoices WHERE id = ?", [invoicePk])) as any[]
      await postAndRecord(full, session.userId)
    } catch (error) {
      return NextResponse.json(
        { ok: true, id: invoicePk, invoice_id: invoiceId, warning: `Saved, but posting failed: ${(error as Error).message}` },
        { status: 201 },
      )
    }
  }

  return NextResponse.json({ ok: true, id: invoicePk, invoice_id: invoiceId }, { status: 201 })
}

/**
 * Post an invoice to the ledger and stamp the voucher back onto the row, then
 * record the audit event. Idempotent: an invoice that already carries a
 * journal_entry_id (voucher) is never posted twice.
 */
async function postAndRecord(inv: Record<string, any>, actorId?: number | null) {
  if (inv.journal_entry_id) return
  // Proforma never posts (spec 35). A Credit Note reverses the AR/revenue that
  // the original invoice created; a Debit Note posts an additional charge in the
  // normal direction (spec 38).
  if (NON_POSTING_TYPES.has(inv.invoice_type)) {
    throw new Error("Proforma invoices cannot be posted to the ledger.")
  }
  const reverse = isCreditNote(inv.invoice_type)
  const result = await postSalesInvoice(inv, { createdBy: actorId ?? null, reverse })
  await query(
    `UPDATE sales_invoices SET journal_entry_id = ?, invoice_status = 'Posted', posted_at = COALESCE(posted_at, NOW()) WHERE id = ?`,
    [result.voucherNo, inv.id],
  )
  await logFinanceEvent({
    entityType: "sales_invoice",
    entityPk: Number(inv.id),
    entityRef: String(inv.invoice_id || inv.id),
    type: "posted",
    summary: `${inv.invoice_type || "Invoice"} ${inv.invoice_id || inv.id} ${reverse ? "reversed on" : "posted to"} ledger (voucher ${result.voucherNo})`,
    amount: result.totalDebit,
    voucherNo: result.voucherNo,
    detail: { journal_entry_ids: result.journalEntryIds, ledger_ids: result.ledgerIds, reverse },
    actorId: actorId ?? null,
  })
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSalesInvoiceSchema()

  const body = await req.json()
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Invoice id is required" }, { status: 400 })

  const [existing] = (await query("SELECT * FROM sales_invoices WHERE id = ?", [id])) as any[]
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const status = String(existing.invoice_status || "Draft")
  const settings = await getSettings()
  const fyStartMonth = FY_MONTH[settings["app.financial_year_start"]] ?? 3

  // ---- Lifecycle immutability -------------------------------------------------
  // Cancelled invoices are frozen entirely.
  if (status === "Cancelled") {
    return NextResponse.json({ error: "Cancelled invoices cannot be edited." }, { status: 409 })
  }

  // Posted / Issued / Sent: restrict edits to the allowed field set. Amounts and
  // line items are frozen; only payment/compliance/status changes are applied.
  if (status !== "Draft") {
    const allowed = status === "Posted" ? POSTED_EDITABLE : POST_ISSUE_EDITABLE
    const attempted = Object.keys(body).filter((k) => k !== "id" && k !== "items")
    const blocked = attempted.filter((k) => !allowed.has(k))
    if (blocked.length > 0) {
      return NextResponse.json(
        { error: `Invoice is ${status}; these fields are locked: ${blocked.join(", ")}. Use a credit/debit note to change amounts.` },
        { status: 409 },
      )
    }
    // Guard status transitions: no going back to Draft, and Posted cannot be
    // cancelled without a credit note.
    if (body.invoice_status && body.invoice_status !== status) {
      const target = String(body.invoice_status)
      const forward: Record<string, string[]> = {
        Issued: ["Sent", "Posted", "Cancelled"],
        Sent: ["Posted", "Cancelled"],
        Posted: [],
      }
      if (!(forward[status] || []).includes(target)) {
        return NextResponse.json({ error: `Cannot move invoice from ${status} to ${target}.` }, { status: 409 })
      }
    }

    // Posting flips the status itself (inside postAndRecord) after writing a
    // balanced voucher, so keep it out of the generic column update to avoid a
    // Posted row that has no ledger entry.
    const wantsPost = body.invoice_status === "Posted"
    const update: Record<string, any> = {}
    for (const field of attempted) update[field] = body[field]
    if (wantsPost) delete update.invoice_status
    if ("amount_received" in update || "payment_status" in update) {
      const pay = recomputePayment(existing.net_receivable, update.amount_received ?? existing.amount_received, update.payment_status)
      Object.assign(update, pay)
    }

    const cols = Object.keys(update)
    if (cols.length > 0) {
      await query(`UPDATE sales_invoices SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`, [...cols.map((c) => update[c]), id])
    }

    if (wantsPost) {
      try {
        const [full] = (await query("SELECT * FROM sales_invoices WHERE id = ?", [id])) as any[]
        await postAndRecord(full, session.userId)
      } catch (error) {
        return NextResponse.json({ error: `Posting failed: ${(error as Error).message}` }, { status: 409 })
      }
    } else if ("amount_received" in update && Number(update.amount_received) !== Number(existing.amount_received)) {
      await logFinanceEvent({
        entityType: "sales_invoice",
        entityPk: id,
        entityRef: String(existing.invoice_id || id),
        type: "payment_recorded",
        summary: `Payment updated on ${existing.invoice_id || id}: received ${update.amount_received}`,
        amount: Number(update.amount_received),
        actorId: session.userId,
      })
    }
    return NextResponse.json({ ok: true })
  }

  // ---- Draft: full edit, full recompute --------------------------------------
  const merged = { ...existing, ...body }
  const sellerGstin = settings["address.tax_number"] || ""
  const sellerStateCode = stateCodeFromGstin(sellerGstin)
  const buyerStateCode = await resolveBuyerStateCode(merged)
  const supplyType = resolveSupplyType({ override: merged.supply_type, sellerStateCode, buyerStateCode })
  const taxEnabled = taxAllowedForType(merged.invoice_type)

  const items = itemsFromBody(merged).map((line, i) => computeItem(line, i, supplyType, taxEnabled))
  if (items.length === 0) return NextResponse.json({ error: "At least one line item is required" }, { status: 400 })
  const header = computeHeaderFromItems(items, {
    tds_applicable: merged.tds_applicable,
    tds_rate: merged.tds_rate,
    amount_received: merged.amount_received,
    payment_status: body.payment_status,
  })
  const first = items[0]

  if (NON_POSTING_TYPES.has(merged.invoice_type) && body.invoice_status === "Posted") {
    return NextResponse.json({ error: "Proforma invoices cannot be posted to the ledger." }, { status: 409 })
  }
  const ruleError = await businessRuleError(merged, header.invoice_total, id)
  if (ruleError) return ruleError

  const update: Record<string, any> = {}
  for (const field of INPUT_FIELDS) {
    if (field in merged) update[field] = merged[field]
  }
  Object.assign(update, {
    financial_year: merged.financial_year || financialYearFor(merged.invoice_date, fyStartMonth),
    seller_gstin: sellerGstin || null,
    seller_state_code: sellerStateCode,
    place_of_supply_code: merged.place_of_supply_code || buyerStateCode || null,
    supply_type: supplyType,
    source_type: deriveSourceType(merged),
    tds_applicable: merged.tds_applicable ? 1 : 0,
    tds_rate: num(merged.tds_rate),
    hsn_sac: first.hsn_sac, quantity: first.quantity, unit: first.unit, rate: first.rate,
    discount: header.discount,
    taxable_amount: header.taxable_amount,
    cgst_percent: header.cgst_percent, cgst_amount: header.cgst_amount,
    sgst_percent: header.sgst_percent, sgst_amount: header.sgst_amount,
    igst_percent: header.igst_percent, igst_amount: header.igst_amount,
    other_tax_cess: header.other_tax_cess,
    invoice_total: header.invoice_total,
    tds_amount: header.tds_amount,
    net_receivable: header.net_receivable,
    amount_received: header.amount_received,
    outstanding_amount: header.outstanding_amount,
    payment_status: header.payment_status,
  })
  if (body.invoice_status === "Issued" && status === "Draft") update.issued_at = new Date()
  // Posting owns the flip to Posted (see postAndRecord); never write it here.
  const wantsPost = body.invoice_status === "Posted"
  if (wantsPost) update.invoice_status = "Issued"

  const cols = Object.keys(update)
  await query(`UPDATE sales_invoices SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`, [...cols.map((c) => update[c]), id])
  await replaceItems(id, items)

  if (body.invoice_status === "Issued" && status === "Draft") {
    await logFinanceEvent({
      entityType: "sales_invoice",
      entityPk: id,
      entityRef: String(existing.invoice_id || id),
      type: "issued",
      summary: `Invoice ${existing.invoice_id || id} issued`,
      amount: header.invoice_total,
      actorId: session.userId,
    })
  }

  if (wantsPost) {
    try {
      const [full] = (await query("SELECT * FROM sales_invoices WHERE id = ?", [id])) as any[]
      await postAndRecord(full, session.userId)
    } catch (error) {
      return NextResponse.json({ error: `Saved as Issued, but posting failed: ${(error as Error).message}` }, { status: 409 })
    }
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSalesInvoiceSchema()
  const id = Number(req.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Invoice id is required" }, { status: 400 })

  // Only Draft invoices may be hard-deleted; anything posted/issued must be
  // reversed with a credit note to preserve the audit trail.
  const [existing] = (await query("SELECT invoice_status FROM sales_invoices WHERE id = ?", [id])) as any[]
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
  if (String(existing.invoice_status || "Draft") !== "Draft") {
    return NextResponse.json({ error: "Only Draft invoices can be deleted. Issue a credit note instead." }, { status: 409 })
  }

  await query(`DELETE FROM sales_invoice_items WHERE invoice_pk = ?`, [id])
  await query("DELETE FROM sales_invoices WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
