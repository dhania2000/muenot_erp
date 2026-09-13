import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getFinanceEvents, logFinanceEvent } from "@/lib/finance-audit"
import { ensureCustomerVendorGstColumns } from "@/lib/finance-ensure"
import {
  verifyGstin,
  normalizeGstin,
  panFromGstin,
  registrationTypeFromTaxpayer,
  verificationStatusLabel,
} from "@/lib/gstin"

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

/** Days between a due date and today; negative means not yet due. */
function daysOverdue(due: any): number {
  if (!due) return 0
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return 0
  const today = new Date()
  const ms = today.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)
  return Math.floor(ms / 86_400_000)
}

async function loadVendor(id: string) {
  // The route accepts either the business id (VEN-####, party_id) or the numeric pk.
  const isNumeric = /^\d+$/.test(id)
  const rows = (await query(
    `SELECT * FROM customers_vendors WHERE ${isNumeric ? "id = ? OR party_id = ?" : "party_id = ?"} LIMIT 1`,
    isNumeric ? [Number(id), id] : [id],
  )) as any[]
  return rows[0] ?? null
}

/**
 * Vendor 360 — a single read that assembles the master record together with
 * every finance transaction that references it (purchase bills, payments,
 * ledger), the computed payables / ageing rollup, KYC + compliance readiness,
 * and the audit trail. All figures are derived on the server from stored
 * documents so the browser never recomputes money.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureCustomerVendorGstColumns()
  const { id } = await ctx.params
  const vendor = await loadVendor(id)
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })

  const partyId: string = vendor.party_id
  const vendorName: string = vendor.customer_name

  // Purchase bills link by vendor_id (party_id); older rows may only carry the
  // vendor name, so match either. Newest first.
  const bills = (await query(
    `SELECT id, po_number, bill_date, due_date, project_name, description,
            gross_bill_amount, net_payable, amount_paid, outstanding_amount,
            tds_amount, payment_status, financial_year
       FROM purchase_bills
      WHERE vendor_id = ? OR (COALESCE(vendor_id,'') = '' AND vendor_name = ?)
      ORDER BY bill_date DESC, id DESC`,
    [partyId, vendorName],
  )) as any[]

  const payments = (await query(
    `SELECT id, payment_id, payment_date, amount, payment_mode, reference_no,
            narration, status, financial_year, invoice_ref
       FROM payments
      WHERE party_id = ? AND status = 'Active'
      ORDER BY payment_date DESC, id DESC`,
    [partyId],
  )) as any[]

  const ledger = (await query(
    `SELECT id, ledger_id, transaction_date, voucher_type, reference_no,
            description, debit, credit, balance, balance_type
       FROM general_ledger
      WHERE party_id = ?
      ORDER BY transaction_date DESC, id DESC
      LIMIT 200`,
    [partyId],
  )) as any[]

  // ---- Payables + ageing (from outstanding bills) -------------------------
  const ageing = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 }
  let totalBilled = 0
  let totalPaid = 0
  let outstanding = 0
  let overdue = 0
  for (const b of bills) {
    totalBilled += num(b.gross_bill_amount)
    totalPaid += num(b.amount_paid)
    const out = num(b.outstanding_amount)
    outstanding += out
    if (out <= 0) continue
    const od = daysOverdue(b.due_date)
    if (od > 0) overdue += out
    if (od <= 0) ageing.current += out
    else if (od <= 30) ageing.d30 += out
    else if (od <= 60) ageing.d60 += out
    else if (od <= 90) ageing.d90 += out
    else ageing.d90plus += out
  }

  const openBills = bills.filter((b) => num(b.outstanding_amount) > 0).length

  const stats = {
    totalBilled: round2(totalBilled),
    totalPaid: round2(totalPaid),
    outstanding: round2(outstanding),
    overdue: round2(overdue),
    billCount: bills.length,
    openBills,
    paymentCount: payments.length,
    lastBillDate: bills[0]?.bill_date ?? null,
    lastPaymentDate: payments[0]?.payment_date ?? null,
    ageing: {
      current: round2(ageing.current),
      d30: round2(ageing.d30),
      d60: round2(ageing.d60),
      d90: round2(ageing.d90),
      d90plus: round2(ageing.d90plus),
    },
  }

  // ---- KYC + compliance readiness -----------------------------------------
  const gstStatus = String(vendor.gst_verification_status ?? "").trim()
  const gstVerified = gstStatus === "Verified"
  const hasBank = !!(vendor.bank_account_no && vendor.ifsc)
  const hasPan = !!vendor.pan
  const hasContact = !!(vendor.official_email || vendor.mobile)
  const hasAddress = !!(vendor.registered_address || vendor.billing_address)
  const tdsOk = !vendor.tds_applicable || (!!vendor.tds_section && num(vendor.tds_rate) > 0)

  const checklist = [
    { key: "gstin", label: "GSTIN verified", done: gstVerified, hint: gstStatus || "Not verified" },
    { key: "pan", label: "PAN on record", done: hasPan },
    { key: "bank", label: "Bank account + IFSC", done: hasBank },
    { key: "contact", label: "Contact (email or mobile)", done: hasContact },
    { key: "address", label: "Address on record", done: hasAddress },
    { key: "tds", label: "TDS configured", done: tdsOk, hint: vendor.tds_applicable ? "TDS applicable" : "Not applicable" },
  ]
  const doneCount = checklist.filter((c) => c.done).length
  const kycScore = Math.round((doneCount / checklist.length) * 100)
  const financeReady = gstVerified && hasBank && hasPan && String(vendor.status) === "Active"

  const audit = vendor.id ? await getFinanceEvents("customer_vendor", Number(vendor.id)) : []

  return NextResponse.json({
    vendor,
    bills,
    payments,
    ledger,
    stats,
    compliance: { checklist, kycScore, financeReady, gstVerified },
    audit,
  })
}

/**
 * Re-verify the vendor's GSTIN against the GST network and persist the fresh
 * snapshot. Detects material changes (portal status, trade name, taxpayer type)
 * versus the stored snapshot and records them on the audit trail so a vendor
 * that was cancelled or suspended after onboarding is caught.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureCustomerVendorGstColumns()
  const { id } = await ctx.params
  const vendor = await loadVendor(id)
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })

  const gstin = normalizeGstin(vendor.gstin)
  if (!gstin) return NextResponse.json({ error: "This vendor has no GSTIN on record." }, { status: 400 })

  const result = await verifyGstin(gstin)
  const newStatus = verificationStatusLabel(result)
  const now = new Date().toISOString().slice(0, 19).replace("T", " ")

  const changes: string[] = []
  const prevStatus = String(vendor.gst_verification_status ?? "").trim()
  if (prevStatus && prevStatus !== newStatus) changes.push(`Verification ${prevStatus} → ${newStatus}`)

  const update: Record<string, any> = {
    gst_verification_status: newStatus,
    gst_verified_at: now,
    gst_verification_source: "gstinapi.in",
  }

  if (result.ok && result.data) {
    const d = result.data
    const fields: Record<string, any> = {
      gst_trade_name: d.tradeName,
      gst_status: d.status,
      gst_taxpayer_type: d.taxpayerType,
      business_constitution: d.businessConstitution,
      gst_registration_date: d.registrationDate,
      gst_cancellation_date: d.cancellationDate,
      gst_block_status: d.blockStatus,
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || String(v).trim() === "") continue
      const prev = String(vendor[k] ?? "").trim()
      if (prev && prev !== String(v).trim()) {
        changes.push(`${k.replace(/_/g, " ")}: ${prev} → ${v}`)
      }
      update[k] = v
    }
    // Backfill empty master fields the portal can authoritatively provide.
    if (!vendor.pan) { const pan = panFromGstin(gstin); if (pan) update.pan = pan }
    if (!vendor.legal_name && d.legalName) update.legal_name = d.legalName
    if (!vendor.state && d.stateName) update.state = d.stateName
    if (!vendor.state_code && d.stateCode) update.state_code = d.stateCode
    if (!vendor.gst_registration_type) {
      const rt = registrationTypeFromTaxpayer(d.taxpayerType)
      if (rt) update.gst_registration_type = rt
    }
  }

  const cols = Object.keys(update)
  await query(
    `UPDATE customers_vendors SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
    [...cols.map((c) => update[c]), vendor.id],
  )

  void logFinanceEvent({
    entityType: "customer_vendor",
    entityPk: Number(vendor.id),
    entityRef: gstin,
    type: "override",
    summary: `GSTIN re-verified: ${newStatus}${changes.length ? ` (${changes.length} change${changes.length > 1 ? "s" : ""})` : ""}`,
    detail: { state: result.state, status: result.data?.status ?? null, changes, cached: result.cached },
    actorId: session.userId,
  })

  return NextResponse.json({
    ok: true,
    verificationStatus: newStatus,
    state: result.state,
    message: result.message,
    changes,
    cached: result.cached,
  })
}
