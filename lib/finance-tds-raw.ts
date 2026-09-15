import "server-only"
import { query } from "@/lib/db"
import { tdsDetail, type TdsDirection } from "@/lib/finance-tds-filing"
import {
  monthsOfFy,
  quarterOfPeriod,
  formForSection,
  getDeductorIdentity,
  type TdsQuarter,
  type TdsReturnForm,
} from "@/lib/finance-tds-compliance"
import { listTdsRules } from "@/lib/finance-tds-rules"

/**
 * Raw TDS Data register (Phases 58–60).
 *
 * This is the single, full-year, line-level view that sits UNDER every other
 * TDS stage. It does NOT introduce a second calculation engine: it replays the
 * existing filing engine (`tdsDetail`) across the 12 months of a financial year
 * and across every direction (payable / employee / receivable), then stitches
 * each source line together with the statutory context that lives in the
 * downstream compliance tables:
 *
 *   - quarter / month / FY / TAN           (period + deductor identity)
 *   - payment type (nature of payment)     (TDS rule master, by section)
 *   - interest / late fee                  (tds_challans, allocated per line)
 *   - return type + return status          (tds_returns, by form + quarter)
 *   - challan / paid / balance             (tdsDetail coverage)
 *
 * Because it reuses `tdsDetail`, every rupee here ties back to exactly the same
 * source document (FTE / freelance invoice, purchase bill, expense, sales
 * invoice) the rest of the module reports on — there is no duplicate TDS engine.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

const ALL_DIRECTIONS: TdsDirection[] = ["payable", "employee", "receivable"]

const DIRECTION_LABEL: Record<TdsDirection, string> = {
  payable: "Vendor",
  employee: "Employee / Freelancer",
  receivable: "Customer (26AS)",
}

export type TdsRawRow = {
  financial_year: string
  quarter: TdsQuarter
  month: string
  tan: string
  direction: TdsDirection
  tds_type: string
  source: string
  source_id: string
  doc_ref: string
  doc_date: string | null
  deductee_id: string
  deductee_name: string
  pan: string
  pan_status: string
  section: string
  payment_type: string
  resident_status: "Resident" | "Non-Resident"
  gross: number
  rate: number
  tds: number
  interest: number
  late_fee: number
  total_liability: number
  paid: number
  balance: number
  challan: string
  return_type: TdsReturnForm
  return_status: string
}

export type TdsRawFacets = {
  quarters: string[]
  months: string[]
  sources: string[]
  sections: string[]
  payment_types: string[]
  return_types: string[]
  statuses: string[]
}

export type TdsRawResult = {
  financial_year: string
  rows: TdsRawRow[]
  totals: {
    line_count: number
    gross: number
    tds: number
    interest: number
    late_fee: number
    total_liability: number
    paid: number
    balance: number
  }
  facets: TdsRawFacets
}

/** Latest-revision return status per (direction, form, quarter) for the FY. */
async function returnStatusMap(financialYear: string) {
  const rows = (await query(
    `SELECT direction, form_type, quarter, status, revision_no
       FROM tds_returns
      WHERE financial_year = ?
      ORDER BY revision_no ASC, id ASC`,
    [financialYear],
  ).catch(() => [])) as any[]
  const map = new Map<string, string>()
  for (const r of rows) {
    // ordered ascending, so the last write for a key wins = latest revision.
    map.set(`${r.direction}|${String(r.form_type).toUpperCase()}|${r.quarter}`, String(r.status || ""))
  }
  return map
}

/** Month-level interest + late fee actually recorded on challans, per direction. */
async function challanChargeMap(financialYear: string, months: string[]) {
  if (months.length === 0) return new Map<string, { interest: number; late_fee: number }>()
  const placeholders = months.map(() => "?").join(",")
  const rows = (await query(
    `SELECT direction, period,
            COALESCE(SUM(interest),0) AS interest,
            COALESCE(SUM(late_fee),0) AS late_fee
       FROM tds_challans
      WHERE period IN (${placeholders})
      GROUP BY direction, period`,
    months,
  ).catch(() => [])) as any[]
  const map = new Map<string, { interest: number; late_fee: number }>()
  for (const r of rows) {
    map.set(`${r.direction}|${r.period}`, { interest: num(r.interest), late_fee: num(r.late_fee) })
  }
  return map
}

/**
 * Build the full-year raw register. `direction` narrows to a single TDS type;
 * omit it (or pass "all") to span vendor + employee + receivable together.
 */
export async function tdsRawData(
  financialYear: string,
  opts: { direction?: TdsDirection | "all" } = {},
): Promise<TdsRawResult> {
  const months = monthsOfFy(financialYear)
  const dirs =
    opts.direction && opts.direction !== "all" ? [opts.direction as TdsDirection] : ALL_DIRECTIONS

  const [deductor, rules, returnStatus, charges] = await Promise.all([
    getDeductorIdentity(),
    listTdsRules(),
    returnStatusMap(financialYear),
    challanChargeMap(financialYear, months),
  ])

  const natureBySection = new Map<string, string>()
  for (const r of rules) {
    if (!natureBySection.has(r.section)) natureBySection.set(r.section, r.nature_of_payment)
  }

  const rows: TdsRawRow[] = []

  for (const month of months) {
    const quarter = quarterOfPeriod(month)
    for (const dir of dirs) {
      const detail = (await tdsDetail(month, dir, { coverage: true })) as any[]
      if (detail.length === 0) continue

      const monthTds = detail.reduce((s, r) => s + num(r.tds), 0)
      const charge = charges.get(`${dir}|${month}`) || { interest: 0, late_fee: 0 }

      for (const d of detail) {
        const section = String(d.section || "")
        const form = formForSection(section, dir)
        const tds = round2(num(d.tds))
        // Statutory interest / late fee are period-level; attribute them to a
        // line in proportion to that line's share of the month's deducted TDS.
        const share = monthTds > 0 ? tds / monthTds : 0
        const interest = round2(charge.interest * share)
        const lateFee = round2(charge.late_fee * share)
        const totalLiability = round2(tds + interest + lateFee)

        const isReceivable = dir === "receivable"
        const returnStat = isReceivable
          ? "26AS Credit"
          : returnStatus.get(`${dir}|${form}|${quarter}`) || "Not filed"

        rows.push({
          financial_year: financialYear,
          quarter,
          month,
          tan: isReceivable ? "" : deductor.tan,
          direction: dir,
          tds_type: DIRECTION_LABEL[dir],
          source: String(d.source || ""),
          source_id: String(d.doc_id || ""),
          doc_ref: String(d.doc_ref || d.doc_id || ""),
          doc_date: d.doc_date ? String(d.doc_date).slice(0, 10) : null,
          deductee_id: String(d.party_id || ""),
          deductee_name: String(d.party_name || "—"),
          pan: String(d.pan || ""),
          pan_status: String(d.pan_status || "Missing"),
          section,
          payment_type: natureBySection.get(section) || section || "—",
          resident_status: form === "27Q" ? "Non-Resident" : "Resident",
          gross: round2(num(d.base)),
          rate: round2(num(d.rate)),
          tds,
          interest,
          late_fee: lateFee,
          total_liability: totalLiability,
          paid: round2(num(d.paid)),
          balance: round2(num(d.balance)),
          challan: String(d.challan || ""),
          return_type: form,
          return_status: returnStat,
        })
      }
    }
  }

  rows.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1
    return b.tds - a.tds
  })

  const totals = rows.reduce(
    (acc, r) => {
      acc.line_count += 1
      acc.gross = round2(acc.gross + r.gross)
      acc.tds = round2(acc.tds + r.tds)
      acc.interest = round2(acc.interest + r.interest)
      acc.late_fee = round2(acc.late_fee + r.late_fee)
      acc.total_liability = round2(acc.total_liability + r.total_liability)
      acc.paid = round2(acc.paid + r.paid)
      acc.balance = round2(acc.balance + r.balance)
      return acc
    },
    { line_count: 0, gross: 0, tds: 0, interest: 0, late_fee: 0, total_liability: 0, paid: 0, balance: 0 },
  )

  const uniqSorted = (vals: string[]) => Array.from(new Set(vals.filter(Boolean))).sort()

  const facets: TdsRawFacets = {
    quarters: uniqSorted(rows.map((r) => r.quarter)),
    months: uniqSorted(rows.map((r) => r.month)),
    sources: uniqSorted(rows.map((r) => r.source)),
    sections: uniqSorted(rows.map((r) => r.section)),
    payment_types: uniqSorted(rows.map((r) => r.payment_type)),
    return_types: uniqSorted(rows.map((r) => r.return_type)),
    statuses: uniqSorted(rows.map((r) => r.return_status)),
  }

  return { financial_year: financialYear, rows, totals, facets }
}
