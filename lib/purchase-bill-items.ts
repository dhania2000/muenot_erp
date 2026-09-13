import "server-only"
import { query } from "@/lib/db"
import { round2, num } from "@/lib/finance-calc"
import { computeItem, type SupplyType, type ComputedItem } from "@/lib/sales-invoice-compute"

/**
 * Purchase Bill line items (Phase 6/7).
 *
 * A bill can carry many line items, each with its own HSN/SAC, quantity, rate,
 * discount and GST rate. The server is authoritative: it recomputes every line
 * from the raw inputs (reusing the shared GST line engine so the intra/inter
 * split matches sales), aggregates them into the bill header, and stores the
 * frozen lines in purchase_bill_items.
 */

export type RawBillItem = {
  description?: string | null
  hsn_sac?: string | null
  quantity?: any
  unit?: string | null
  rate?: any
  discount_type?: string | null
  discount_value?: any
  tax_rate?: any
  cess_amount?: any
  itc_eligibility?: string | null
}

export type BillItemTotals = {
  taxable_amount: number
  discount: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  other_tax_cess: number
  gross_bill_amount: number
  gst_rate: number
}

/** Compute every line + the header aggregate for a set of raw items. */
export function computeBillItems(
  raw: RawBillItem[],
  supplyType: SupplyType,
): { items: (ComputedItem & { itc_eligibility: string })[]; totals: BillItemTotals } {
  const items = raw
    .filter((r) => r && (num(r.quantity) > 0 || num(r.rate) > 0 || num(r.tax_rate) > 0 || String(r.description ?? "").trim()))
    .map((r, i) => ({
      ...computeItem(r, i, supplyType, true),
      itc_eligibility: r.itc_eligibility === "Ineligible" ? "Ineligible" : "Eligible",
    }))

  const sum = (fn: (i: ComputedItem) => number) => round2(items.reduce((a, i) => a + fn(i), 0))
  const taxable = sum((i) => i.taxable_value)
  const cgst = sum((i) => i.cgst_amount)
  const sgst = sum((i) => i.sgst_amount)
  const igst = sum((i) => i.igst_amount)
  const cess = sum((i) => i.cess_amount)
  const gross = round2(taxable + cgst + sgst + igst + cess)
  // Blended GST rate (weighted by taxable) for the header display column.
  const gstRate = taxable > 0 ? round2(((cgst + sgst + igst) / taxable) * 100) : 0

  return {
    items,
    totals: {
      taxable_amount: taxable,
      discount: sum((i) => i.discount_amount),
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      other_tax_cess: cess,
      gross_bill_amount: gross,
      gst_rate: gstRate,
    },
  }
}

/** Replace the persisted line items for a bill (frozen snapshot). */
export async function persistBillItems(
  billId: string,
  items: (ComputedItem & { itc_eligibility: string })[],
): Promise<void> {
  await query(`DELETE FROM purchase_bill_items WHERE bill_id = ?`, [billId])
  let lineNo = 1
  for (const it of items) {
    await query(
      `INSERT INTO purchase_bill_items
         (bill_id, line_no, description, hsn_sac, quantity, unit, rate, discount_type,
          discount_value, discount_amount, taxable_value, gst_rate, cgst_percent, cgst_amount,
          sgst_percent, sgst_amount, igst_percent, igst_amount, cess_amount, line_total, itc_eligibility)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        billId, lineNo++, it.description, it.hsn_sac, it.quantity, it.unit, it.rate, it.discount_type,
        it.discount_value, it.discount_amount, it.taxable_value, it.tax_rate, it.cgst_percent, it.cgst_amount,
        it.sgst_percent, it.sgst_amount, it.igst_percent, it.igst_amount, it.cess_amount, it.line_total,
        it.itc_eligibility,
      ],
    )
  }
}

/** Read the persisted line items for a bill, ordered by line number. */
export async function listBillItems(billId: string): Promise<Record<string, any>[]> {
  return (await query<any[]>(
    `SELECT * FROM purchase_bill_items WHERE bill_id = ? ORDER BY line_no ASC, id ASC`,
    [billId],
  )) as any[]
}
