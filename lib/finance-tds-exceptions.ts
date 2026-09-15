import "server-only"
import { tdsRawData } from "@/lib/finance-tds-raw"
import {
  tdsLiability,
  tdsReconciliation,
  listChallans,
  listTdsReturns,
  listCertificates,
  getDeductorIdentity,
  depositDueDate,
  returnDueDate,
  quarterOfPeriod,
  isDeductorDirection,
  type TdsQuarter,
} from "@/lib/finance-tds-compliance"
import { detectTdsDuplicates } from "@/lib/finance-tds-trace"
import { listTdsRules } from "@/lib/finance-tds-rules"
import type { TdsDirection } from "@/lib/finance-tds-filing"

/**
 * TDS Exception Center (Phase 63).
 *
 * This is NOT a new calculation engine. It is a read-only auditor that runs the
 * existing engines (raw register, liability, reconciliation, challans, returns,
 * certificates, duplicate tracer, rule master) for a financial year + direction
 * and surfaces every compliance gap as a categorized exception. Because every
 * number is derived from the same sources the rest of the module reports on, an
 * exception here always points back to a real source document, period, or
 * statutory record — nothing is fabricated or double-counted.
 *
 * The same report powers the Exception Center UI (Phase 63), the CA review
 * package (Phase 62), the scheduled sweeps (Phase 64) and the notification
 * feed (Phase 65).
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

export type TdsExceptionSeverity = "error" | "warning" | "info"

export type TdsExceptionRow = {
  ref: string
  label: string
  detail: string
  section?: string
  period?: string
  quarter?: string
  amount: number
}

export type TdsExceptionCategory = {
  key: string
  label: string
  severity: TdsExceptionSeverity
  description: string
  count: number
  amount: number
  rows: TdsExceptionRow[]
}

export type TdsExceptionReport = {
  financial_year: string
  direction: TdsDirection
  deductor: boolean
  generated_at: string
  categories: TdsExceptionCategory[]
  totals: {
    categories_flagged: number
    total_exceptions: number
    errors: number
    warnings: number
    exposure: number
  }
}

const CATALOG: Array<{ key: string; label: string; severity: TdsExceptionSeverity; description: string }> = [
  { key: "pan_missing", label: "PAN Missing", severity: "error", description: "Deductee has no PAN — TDS must be deducted at the higher no-PAN rate (§206AA)." },
  { key: "pan_invalid", label: "PAN Invalid", severity: "error", description: "Deductee PAN fails the structural check and will be rejected by TRACES." },
  { key: "tan_missing", label: "TAN Missing", severity: "error", description: "Deductor TAN is not configured — challans and returns cannot be filed." },
  { key: "wrong_section", label: "Wrong Section", severity: "error", description: "Deducted under a section that is not present in the TDS rule master." },
  { key: "wrong_rate", label: "Wrong Rate", severity: "warning", description: "Applied rate does not match any active rate configured for the section." },
  { key: "threshold_error", label: "Threshold Error", severity: "warning", description: "Annual payment crossed the threshold but no TDS was deducted." },
  { key: "missing_challan", label: "Missing Challan", severity: "error", description: "TDS was deducted for the month but no deposit challan is recorded." },
  { key: "late_payment", label: "Late Payment", severity: "warning", description: "Challan deposited after the statutory due date (§201 interest applies)." },
  { key: "late_filing", label: "Late Filing", severity: "warning", description: "Quarterly return filed after — or still pending past — the due date (§234E)." },
  { key: "unpaid_tds", label: "Unpaid TDS", severity: "error", description: "Deducted TDS (with interest / late fee) is not yet fully deposited." },
  { key: "duplicate_tds", label: "Duplicate TDS", severity: "error", description: "The same source document has been picked up more than once." },
  { key: "source_mismatch", label: "Source Mismatch", severity: "warning", description: "Books vs. deposited variance for the quarter (challan reconciliation)." },
  { key: "return_mismatch", label: "Return Mismatch", severity: "warning", description: "Books vs. filed-return variance for the quarter." },
  { key: "certificate_pending", label: "Certificate Pending", severity: "warning", description: "Return is filed but Form 16 / 16A has not been issued to the deductee." },
]

function emptyCategories(): Map<string, TdsExceptionCategory> {
  const map = new Map<string, TdsExceptionCategory>()
  for (const c of CATALOG) {
    map.set(c.key, { ...c, count: 0, amount: 0, rows: [] })
  }
  return map
}

function push(cat: TdsExceptionCategory, row: TdsExceptionRow) {
  cat.rows.push(row)
  cat.count += 1
  cat.amount = round2(cat.amount + Math.abs(row.amount))
}

/** Cap the number of detail rows kept per category so payloads stay bounded. */
const ROW_CAP = 200

export async function tdsExceptionReport(
  financialYear: string,
  direction: TdsDirection,
): Promise<TdsExceptionReport> {
  const deductor = isDeductorDirection(direction)
  const cats = emptyCategories()

  const [raw, deductorIdentity, rules] = await Promise.all([
    tdsRawData(financialYear, { direction }).catch(() => null),
    getDeductorIdentity().catch(() => null),
    listTdsRules(true).catch(() => []),
  ])

  // Active rate + known-section lookups from the rule master.
  const knownSections = new Set<string>()
  const ratesBySection = new Map<string, Set<number>>()
  const annualThreshold = new Map<string, number>()
  for (const r of rules) {
    const sec = String(r.section || "").trim().toUpperCase()
    if (!sec) continue
    knownSections.add(sec)
    if (!ratesBySection.has(sec)) ratesBySection.set(sec, new Set())
    ratesBySection.get(sec)!.add(round2(r.rate))
    ratesBySection.get(sec)!.add(round2(r.rate_no_pan))
    annualThreshold.set(sec, Math.max(annualThreshold.get(sec) ?? 0, num(r.threshold_annual)))
  }

  // --- TAN Missing (deductor only) ---------------------------------------
  if (deductor && (!deductorIdentity || !String(deductorIdentity.tan || "").trim())) {
    const hasRows = !!raw && raw.rows.some((r) => r.tds > 0)
    if (hasRows) {
      push(cats.get("tan_missing")!, {
        ref: "deductor",
        label: "Deductor profile",
        detail: "TAN is not set in the deductor identity. Configure it before generating challans or returns.",
        amount: 0,
      })
    }
  }

  // --- Line-level exceptions from the raw register -----------------------
  if (raw) {
    // Aggregate base per (deductee, section) for the threshold check.
    const aggBase = new Map<string, { base: number; tds: number; name: string; section: string }>()

    for (const r of raw.rows) {
      const sec = String(r.section || "").trim().toUpperCase()

      if (r.pan_status === "Missing") {
        const cat = cats.get("pan_missing")!
        if (cat.rows.length < ROW_CAP)
          push(cat, {
            ref: r.source_id,
            label: r.deductee_name,
            detail: `${r.source} ${r.doc_ref} — no PAN on record`,
            section: r.section,
            period: r.month,
            quarter: r.quarter,
            amount: r.tds,
          })
        else cat.count += 1
      } else if (r.pan_status === "Invalid") {
        const cat = cats.get("pan_invalid")!
        if (cat.rows.length < ROW_CAP)
          push(cat, {
            ref: r.source_id,
            label: r.deductee_name,
            detail: `${r.source} ${r.doc_ref} — PAN ${r.pan} is structurally invalid`,
            section: r.section,
            period: r.month,
            quarter: r.quarter,
            amount: r.tds,
          })
        else cat.count += 1
      }

      if (sec && !knownSections.has(sec)) {
        const cat = cats.get("wrong_section")!
        if (cat.rows.length < ROW_CAP)
          push(cat, {
            ref: r.source_id,
            label: r.deductee_name,
            detail: `Section ${r.section} is not defined in the rule master`,
            section: r.section,
            period: r.month,
            quarter: r.quarter,
            amount: r.tds,
          })
        else cat.count += 1
      } else if (sec && r.tds > 0 && r.rate > 0) {
        const allowed = ratesBySection.get(sec)
        if (allowed && !Array.from(allowed).some((rate) => Math.abs(rate - r.rate) < 0.01)) {
          const cat = cats.get("wrong_rate")!
          if (cat.rows.length < ROW_CAP)
            push(cat, {
              ref: r.source_id,
              label: r.deductee_name,
              detail: `Applied ${r.rate}% on §${r.section}; master allows ${Array.from(allowed).filter((x) => x > 0).join("% / ")}%`,
              section: r.section,
              period: r.month,
              quarter: r.quarter,
              amount: r.tds,
            })
          else cat.count += 1
        }
      }

      // Unpaid TDS (deductor only): balance still outstanding.
      if (deductor && r.balance > 0.5) {
        const cat = cats.get("unpaid_tds")!
        if (cat.rows.length < ROW_CAP)
          push(cat, {
            ref: r.source_id,
            label: r.deductee_name,
            detail: `${r.source} ${r.doc_ref} — balance not deposited`,
            section: r.section,
            period: r.month,
            quarter: r.quarter,
            amount: r.balance,
          })
        else cat.count += 1
      }

      if (deductor && sec) {
        const key = `${r.deductee_id || r.deductee_name}::${sec}`
        const prev = aggBase.get(key) || { base: 0, tds: 0, name: r.deductee_name, section: r.section }
        prev.base = round2(prev.base + r.gross)
        prev.tds = round2(prev.tds + r.tds)
        aggBase.set(key, prev)
      }
    }

    // Threshold error: annual base crossed the section threshold but nothing deducted.
    if (deductor) {
      const thrCat = cats.get("threshold_error")!
      for (const [, agg] of aggBase) {
        const sec = agg.section.trim().toUpperCase()
        const thr = annualThreshold.get(sec) ?? 0
        if (thr > 0 && agg.base > thr && agg.tds <= 0) {
          if (thrCat.rows.length < ROW_CAP)
            push(thrCat, {
              ref: agg.name,
              label: agg.name,
              detail: `Paid ${agg.base.toLocaleString("en-IN")} under §${agg.section} (threshold ${thr.toLocaleString("en-IN")}) with no TDS`,
              section: agg.section,
              amount: agg.base,
            })
          else thrCat.count += 1
        }
      }
    }
  }

  // --- Liability-derived: Missing Challan (deductor only) ----------------
  if (deductor) {
    const liability = await tdsLiability(financialYear, direction).catch(() => null)
    if (liability) {
      const missCat = cats.get("missing_challan")!
      for (const row of liability.rows) {
        if (row.deducted > 0.5 && row.deposited <= 0.5) {
          push(missCat, {
            ref: row.period,
            label: row.period,
            detail: `Deducted ${row.deducted.toLocaleString("en-IN")} — no challan deposited (due ${row.due_date})`,
            period: row.period,
            quarter: row.quarter,
            amount: row.deducted,
          })
        }
      }
    }
  }

  // --- Challan-derived: Late Payment (deductor only) ---------------------
  if (deductor) {
    const challans = await listChallans(direction, financialYear).catch(() => [])
    const lateCat = cats.get("late_payment")!
    for (const c of challans) {
      if (!c.payment_date || !c.period) continue
      const due = depositDueDate(c.period)
      if (due && c.payment_date > due) {
        push(lateCat, {
          ref: c.challan_id,
          label: c.challan_no || c.challan_id,
          detail: `Deposited ${c.payment_date} vs. due ${due} for ${c.period}`,
          period: c.period,
          quarter: c.quarter,
          amount: c.tds_amount,
        })
      }
    }
  }

  // --- Return-derived: Late Filing (deductor only) -----------------------
  if (deductor) {
    const returns = await listTdsReturns(direction).catch(() => [])
    const lateFiling = cats.get("late_filing")!
    const today = new Date().toISOString().slice(0, 10)
    const fyReturns = returns.filter((r) => r.financial_year === financialYear)
    for (const r of fyReturns) {
      const due = returnDueDate(r.quarter as TdsQuarter, financialYear)
      const filedDate = r.filed_at ? r.filed_at.slice(0, 10) : null
      if (filedDate && due && filedDate > due) {
        push(lateFiling, {
          ref: r.return_id,
          label: `${r.form_type} ${r.quarter}`,
          detail: `Filed ${filedDate} vs. due ${due}`,
          quarter: r.quarter,
          amount: r.total_deducted,
        })
      } else if (!filedDate && due && today > due && r.total_deducted > 0) {
        push(lateFiling, {
          ref: r.return_id,
          label: `${r.form_type} ${r.quarter}`,
          detail: `Not filed — due ${due} has passed`,
          quarter: r.quarter,
          amount: r.total_deducted,
        })
      }
    }
  }

  // --- Duplicate TDS -----------------------------------------------------
  {
    const dup = await detectTdsDuplicates(financialYear, direction).catch(() => null)
    if (dup) {
      const dupCat = cats.get("duplicate_tds")!
      for (const g of dup.duplicates) {
        push(dupCat, {
          ref: g.source_txn_id,
          label: `${g.source_module} ${g.source_txn_id}`,
          detail: `Picked up ${g.occurrences}× (${g.section || "—"})`,
          section: g.section,
          amount: num(g.total_tds),
        })
      }
    }
  }

  // --- Reconciliation: Source / Return mismatch --------------------------
  {
    const recon = await tdsReconciliation(financialYear, direction).catch(() => null)
    if (recon && recon.deposit_applicable) {
      const srcCat = cats.get("source_mismatch")!
      const retCat = cats.get("return_mismatch")!
      for (const row of recon.rows) {
        if (Math.abs(row.deposit_variance) > 0.5) {
          push(srcCat, {
            ref: row.quarter,
            label: row.quarter,
            detail: `Deducted ${row.deducted.toLocaleString("en-IN")} vs. deposited ${row.deposited.toLocaleString("en-IN")}`,
            quarter: row.quarter,
            amount: row.deposit_variance,
          })
        }
        if (Math.abs(row.return_variance) > 0.5) {
          push(retCat, {
            ref: row.quarter,
            label: row.quarter,
            detail: `Deducted ${row.deducted.toLocaleString("en-IN")} vs. returned ${row.returned.toLocaleString("en-IN")}`,
            quarter: row.quarter,
            amount: row.return_variance,
          })
        }
      }
    }
  }

  // --- Certificate Pending (deductor only) -------------------------------
  if (deductor) {
    const [returns, certificates] = await Promise.all([
      listTdsReturns(direction).catch(() => []),
      listCertificates(direction, financialYear).catch(() => []),
    ])
    const certCat = cats.get("certificate_pending")!
    const issuedQuarters = new Set(
      certificates.filter((c: any) => String(c.status) !== "Cancelled").map((c: any) => String(c.quarter)),
    )
    const filedReturns = returns.filter(
      (r) => r.financial_year === financialYear && ["Filed", "Accepted", "Processed"].includes(String(r.status)),
    )
    for (const r of filedReturns) {
      if (!issuedQuarters.has(String(r.quarter))) {
        push(certCat, {
          ref: r.return_id,
          label: `${r.form_type === "24Q" ? "Form 16" : "Form 16A"} ${r.quarter}`,
          detail: `${r.deductee_count} deductee(s) in the filed ${r.form_type} ${r.quarter} return have no certificate`,
          quarter: r.quarter,
          amount: r.total_deducted,
        })
      }
    }
  }

  const categories = CATALOG.map((c) => cats.get(c.key)!)
  const flagged = categories.filter((c) => c.count > 0)
  const totals = {
    categories_flagged: flagged.length,
    total_exceptions: categories.reduce((s, c) => s + c.count, 0),
    errors: categories.filter((c) => c.severity === "error").reduce((s, c) => s + c.count, 0),
    warnings: categories.filter((c) => c.severity === "warning").reduce((s, c) => s + c.count, 0),
    exposure: round2(
      categories
        .filter((c) => ["unpaid_tds", "missing_challan", "threshold_error"].includes(c.key))
        .reduce((s, c) => s + c.amount, 0),
    ),
  }

  return {
    financial_year: financialYear,
    direction,
    deductor,
    generated_at: new Date().toISOString(),
    categories,
    totals,
  }
}
