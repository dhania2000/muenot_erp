import "server-only"
import { pool, query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import { computePurchaseBill, addDays, round2 } from "@/lib/finance-calc"
import { stateCodeFromGstin, resolveSupplyType } from "@/lib/sales-invoice-compute"

/**
 * Purchase Bill server engine (Phases 1–5).
 *
 * This module owns everything about a Purchase Bill that must NOT be trusted to
 * the browser:
 *   - the immutable, server-generated, concurrency-safe Bill ID (Phase 1);
 *   - the authoritative vendor snapshot pulled from the Vendor master (Phase 2)
 *     including the already-verified GSTIN data (Phase 3);
 *   - the authoritative money recalculation with place-of-supply GST (Phase 5).
 */

const FY_START_MONTH: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

/** Financial-year start calendar year for a bill date, honouring company settings. */
function fyStartYear(dateStr: string | null | undefined, startMonth: number): number {
  const d = dateStr ? new Date(dateStr) : new Date()
  const valid = !Number.isNaN(d.getTime()) ? d : new Date()
  const y = valid.getFullYear()
  return valid.getMonth() >= startMonth ? y : y - 1
}

/**
 * Generate the next Purchase Bill ID: `PB-2026-000001` (Phase 1).
 *
 * The number is scoped to the financial year and drawn from the shared
 * `record_id_sequences` table inside a transaction with `FOR UPDATE`, so it is
 * unique and concurrency-safe (never MAX+1). The returned id is immutable — the
 * CRUD factory never rewrites the id column on update.
 */
export async function nextPurchaseBillId(billDate?: string | null): Promise<string> {
  const settings = await getSettings().catch(() => ({}) as Record<string, string>)
  const startMonth = FY_START_MONTH[settings["app.financial_year_start"] as string] ?? 3
  const year = fyStartYear(billDate, startMonth)
  const seqKey = `PB${year}` // <= 20 chars, alphanumeric key for record_id_sequences

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1",
      [seqKey],
    )
    const [rows] = await connection.query<any[]>(
      "SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE",
      [seqKey],
    )
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `PB-${year}-${String(number).padStart(6, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

/** Normalize a PAN: uppercase + trimmed (Phase 26). */
function normalizePan(pan?: string | null): string {
  return String(pan ?? "").trim().toUpperCase()
}

type VendorRow = Record<string, any>

async function loadVendor(vendorId?: string | null, vendorName?: string | null): Promise<VendorRow | null> {
  if (vendorId) {
    const rows = (await query(`SELECT * FROM customers_vendors WHERE party_id = ? LIMIT 1`, [vendorId])) as any[]
    if (rows[0]) return rows[0]
  }
  if (vendorName) {
    const rows = (await query(`SELECT * FROM customers_vendors WHERE customer_name = ? LIMIT 1`, [vendorName])) as any[]
    if (rows[0]) return rows[0]
  }
  return null
}

/**
 * Resolve the vendor and recompute every server-owned field for a Purchase Bill.
 *
 * @param merged  the merged record (existing row + client changes)
 * @param opts.isCreate  true on POST — snapshot always refreshes on create
 */
export async function computePurchaseBillServerFields(
  merged: Record<string, any>,
  opts: { isCreate: boolean },
): Promise<Record<string, any>> {
  const out: Record<string, any> = {}

  // --- Phase 2/3: vendor auto-resolution + verified GSTIN snapshot -----------
  const vendor = await loadVendor(merged.vendor_id, merged.vendor_name)
  if (vendor) {
    out.vendor_id = vendor.party_id
    out.vendor_name = vendor.customer_name

    // Fill descriptive snapshot fields. On create we always snapshot; on update
    // we only fill blanks so a posted/historical bill keeps its frozen values
    // unless the field was never set.
    const snap = (billKey: string, vendorVal: any) => {
      if (vendorVal === null || vendorVal === undefined || String(vendorVal).trim() === "") return
      if (opts.isCreate || merged[billKey] === undefined || merged[billKey] === null || String(merged[billKey]).trim() === "") {
        out[billKey] = vendorVal
      }
    }
    snap("vendor_legal_name", vendor.legal_name || vendor.customer_name)
    snap("vendor_gstin", vendor.gstin)
    snap("vendor_pan", normalizePan(vendor.pan))
    snap("vendor_tan", vendor.tan)
    snap("vendor_state", vendor.state)
    snap("vendor_state_code", vendor.state_code || stateCodeFromGstin(vendor.gstin) || "")
    snap("gst_registration_type", vendor.gst_registration_type)
    snap("gst_status", vendor.gst_verification_status)
    snap("billing_address", vendor.billing_address || vendor.registered_address)
    snap("currency", vendor.currency)
    snap("payment_terms", vendor.payment_terms_days)
    // TDS defaults inherited from the vendor tax profile (Phase 2).
    snap("tds_section", vendor.tds_section)
    // Place of supply defaults to the vendor's state but is never assumed to be
    // authoritative — the user can override it (Phase 9).
    snap("place_of_supply", vendor.state)
    snap("place_of_supply_code", vendor.state_code || stateCodeFromGstin(vendor.gstin) || "")
  }

  // Normalize PAN even when hand-entered (Phase 26).
  if (merged.vendor_pan && out.vendor_pan === undefined) out.vendor_pan = normalizePan(merged.vendor_pan)

  // --- Phase 8/9: place-of-supply driven GST (intra vs inter-state) ----------
  const settings = await getSettings().catch(() => ({}) as Record<string, string>)
  const companyGstin = (settings["address.tax_number"] as string) || ""
  const companyStateCode = stateCodeFromGstin(companyGstin)

  const vendorStateCode =
    (out.vendor_state_code as string) ||
    (merged.vendor_state_code as string) ||
    stateCodeFromGstin((out.vendor_gstin as string) || merged.vendor_gstin) ||
    null
  const posCode =
    (out.place_of_supply_code as string) || (merged.place_of_supply_code as string) || vendorStateCode

  // For an inward supply the supply is intra-state when the vendor and the
  // recipient (company) sit in the same state; otherwise inter-state.
  const supplyType = resolveSupplyType({
    override: merged.supply_type,
    sellerStateCode: vendorStateCode,
    buyerStateCode: companyStateCode || posCode,
  })
  out.supply_type = supplyType

  // --- Phase 5: authoritative money recalculation ----------------------------
  const money = computePurchaseBill({ ...merged, ...out, supply_type: supplyType })
  Object.assign(out, money)

  // --- Phase 38: due date from bill date + vendor payment terms --------------
  const hasDue = merged.due_date && String(merged.due_date).trim() !== ""
  if (!hasDue) {
    const terms = Number(out.payment_terms ?? merged.payment_terms)
    const derivedDue = addDays(merged.bill_date, terms)
    if (derivedDue) out.due_date = derivedDue
  }

  return out
}

/**
 * Duplicate-bill guard (Phase 48). Warns when the same vendor already has a bill
 * with the same bill number in the same financial year. Returns the existing
 * bill id or null. Same bill number across *different* vendors is allowed.
 */
export async function findDuplicateBill(
  merged: Record<string, any>,
  excludeId?: number | null,
): Promise<string | null> {
  const billNumber = String(merged.bill_number ?? "").trim()
  const vendorId = String(merged.vendor_id ?? "").trim()
  if (!billNumber || !vendorId) return null
  const rows = (await query(
    `SELECT bill_id FROM purchase_bills
       WHERE vendor_id = ? AND bill_number = ?
         AND (financial_year = ? OR ? = '')
         AND (? IS NULL OR id <> ?)
       LIMIT 1`,
    [vendorId, billNumber, merged.financial_year ?? "", merged.financial_year ?? "", excludeId ?? null, excludeId ?? null],
  )) as any[]
  return rows[0]?.bill_id ?? null
}
