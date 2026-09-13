import { query } from "@/lib/db"

/**
 * Source-document integration for Sales Invoices.
 *
 * An invoice can be raised FROM a Quotation, Contract or Project (spec 14–33).
 * This module is the single place that:
 *   - lists the source documents that belong to a given client,
 *   - resolves a chosen source into commercial auto-fill values,
 *   - computes the remaining billable amount for over-billing protection,
 *   - validates source ↔ client consistency, and
 *   - detects duplicate billing for the same period / milestone.
 *
 * The ERP couples these domains loosely (contracts & quotations live in the
 * sales domain keyed by company, projects in operations keyed by client name),
 * so every cross-domain read is defensive: a missing table or column returns an
 * empty result instead of throwing, exactly like the finance reporting layer.
 */

export type SourceKind = "contract" | "quotation" | "project"

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const normName = (s: any) => String(s ?? "").trim().toLowerCase()

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Net amount already invoiced against a source id (credit notes subtract, proforma/cancelled excluded). */
async function netInvoicedForSource(kind: SourceKind, sourceId: string, excludeInvoicePk?: number): Promise<number> {
  const col = kind === "contract" ? "contract_id" : kind === "quotation" ? "quotation_id" : "project_id"
  const rows = await safe(
    () =>
      query(
        `SELECT COALESCE(SUM(
            CASE WHEN invoice_type = 'Credit Note' THEN -invoice_total ELSE invoice_total END
         ),0) AS net
         FROM sales_invoices
         WHERE ${col} = ?
           AND invoice_status <> 'Cancelled'
           AND invoice_type NOT IN ('Proforma Invoice')
           ${excludeInvoicePk ? "AND id <> ?" : ""}`,
        excludeInvoicePk ? [sourceId, excludeInvoicePk] : [sourceId],
      ) as Promise<any[]>,
    [],
  )
  return round2(num(rows?.[0]?.net))
}

// ---------------------------------------------------------------------------
// Listing sources for a client
// ---------------------------------------------------------------------------

export async function listSourcesForClient(clientName: string) {
  const name = clientName?.trim() || ""
  if (!name) return { contracts: [], quotations: [], projects: [] }
  const like = name

  const [contracts, quotations, projects] = await Promise.all([
    safe(
      () =>
        query(
          `SELECT id, contract_code, title, value, currency, status, start_date, end_date,
                  company_name, notice_period_days
           FROM sales_contracts
           WHERE archived_at IS NULL AND company_name = ?
           ORDER BY created_at DESC LIMIT 50`,
          [like],
        ) as Promise<any[]>,
      [],
    ),
    safe(
      () =>
        query(
          `SELECT q.id, q.quote_code, q.version, q.status, q.grand_total, q.currency, q.payment_terms,
                  q.place_of_supply, c.company_name
           FROM sales_quotations q
           LEFT JOIN sales_companies c ON c.id = q.company_id
           WHERE (q.archived_at IS NULL OR q.archived_at IS NULL)
             AND c.company_name = ?
             AND q.status IN ('Accepted','Sent')
           ORDER BY q.created_at DESC LIMIT 50`,
          [like],
        ) as Promise<any[]>,
      [],
    ),
    safe(
      () =>
        query(
          `SELECT id, project_name, client_id, client_name, status, billing_model, project_manager,
                  manager_name, start_date, end_date
           FROM operations_projects
           WHERE client_name = ?
           ORDER BY id DESC LIMIT 50`,
          [like],
        ) as Promise<any[]>,
      [],
    ),
  ])

  return { contracts, quotations, projects }
}

// ---------------------------------------------------------------------------
// Resolve a single source for auto-fill + billing
// ---------------------------------------------------------------------------

export async function resolveSource(kind: SourceKind, id: string, excludeInvoicePk?: number) {
  if (kind === "contract") {
    const [c] = await safe(
      () =>
        query(
          `SELECT c.*, sq.quote_code AS source_quotation_code
           FROM sales_contracts c
           LEFT JOIN sales_quotations sq ON sq.id = c.source_quotation_id
           WHERE c.id = ? LIMIT 1`,
          [id],
        ) as Promise<any[]>,
      [],
    )
    if (!c) return null
    const invoiced = await netInvoicedForSource("contract", id, excludeInvoicePk)
    const billable = round2(num(c.value))
    return {
      kind,
      code: c.contract_code,
      autofill: {
        client_name: c.company_name,
        contract_id: String(c.id),
        quotation_id: c.source_quotation_id ? String(c.source_quotation_id) : "",
        currency: c.currency || "INR",
        payment_terms_days: c.notice_period_days ?? null,
        source_type: "Contract",
      },
      billing: { billable, invoiced, remaining: round2(billable - invoiced) },
    }
  }

  if (kind === "quotation") {
    const [q] = await safe(
      () =>
        query(
          `SELECT q.*, c.company_name
           FROM sales_quotations q
           LEFT JOIN sales_companies c ON c.id = q.company_id
           WHERE q.id = ? LIMIT 1`,
          [id],
        ) as Promise<any[]>,
      [],
    )
    if (!q) return null
    const items = await safe(
      () =>
        query(
          `SELECT description, hsn_sac, quantity, unit, rate, discount_type, discount_value, tax_rate
           FROM sales_quotation_items WHERE quotation_id = ? ORDER BY line_no ASC`,
          [id],
        ) as Promise<any[]>,
      [],
    )
    const invoiced = await netInvoicedForSource("quotation", id, excludeInvoicePk)
    const billable = round2(num(q.grand_total))
    return {
      kind,
      code: q.quote_code,
      autofill: {
        client_name: q.company_name,
        quotation_id: String(q.id),
        currency: q.currency || "INR",
        place_of_supply: q.place_of_supply || "",
        source_type: "Quotation",
        // Commercial line inputs are copied; the server recomputes all money.
        items: items.map((it) => ({
          description: it.description,
          hsn_sac: it.hsn_sac,
          quantity: it.quantity,
          unit: it.unit,
          rate: it.rate,
          discount_type: it.discount_type === "percent" ? "percent" : "amount",
          discount_value: it.discount_value,
          tax_rate: it.tax_rate,
        })),
      },
      billing: { billable, invoiced, remaining: round2(billable - invoiced) },
    }
  }

  // project
  const [p] = await safe(
    () => query(`SELECT * FROM operations_projects WHERE id = ? LIMIT 1`, [id]) as Promise<any[]>,
    [],
  )
  if (!p) return null
  return {
    kind,
    code: p.project_name,
    autofill: {
      client_name: p.client_name,
      project_id: String(p.id),
      project_name: p.project_name,
      source_type: "Project",
    },
    billing: null,
  }
}

// ---------------------------------------------------------------------------
// Validation used by the invoice POST/PATCH
// ---------------------------------------------------------------------------

export type BillingCheck = {
  overbilling?: { kind: SourceKind; billable: number; invoiced: number; remaining: number; attempted: number }
  duplicate?: { invoice_id: string; invoice_date: string }
  consistency?: string
}

/** Confirm a linked source actually belongs to the invoice's client (spec 29–31). */
async function consistencyError(clientName: string, contractId?: string, quotationId?: string, projectId?: string) {
  const target = normName(clientName)
  if (!target) return null

  if (contractId) {
    const [c] = await safe(
      () => query(`SELECT company_name FROM sales_contracts WHERE id = ? LIMIT 1`, [contractId]) as Promise<any[]>,
      [],
    )
    if (c && normName(c.company_name) && normName(c.company_name) !== target)
      return `Selected contract belongs to ${c.company_name}, not ${clientName}.`
  }
  if (quotationId) {
    const [q] = await safe(
      () =>
        query(
          `SELECT co.company_name FROM sales_quotations q LEFT JOIN sales_companies co ON co.id = q.company_id WHERE q.id = ? LIMIT 1`,
          [quotationId],
        ) as Promise<any[]>,
      [],
    )
    if (q && normName(q.company_name) && normName(q.company_name) !== target)
      return `Selected quotation belongs to ${q.company_name}, not ${clientName}.`
  }
  if (projectId) {
    const [p] = await safe(
      () => query(`SELECT client_name FROM operations_projects WHERE id = ? LIMIT 1`, [projectId]) as Promise<any[]>,
      [],
    )
    if (p && normName(p.client_name) && normName(p.client_name) !== target)
      return `Selected project belongs to ${p.client_name}, not ${clientName}.`
  }
  return null
}

/** Same client + contract/project + billing period (+ milestone) already billed? (spec 24–26) */
async function duplicateBilling(opts: {
  clientName?: string
  contractId?: string
  projectId?: string
  milestoneId?: string
  from?: string
  to?: string
  excludeInvoicePk?: number
}) {
  const { contractId, projectId, milestoneId, from, to, excludeInvoicePk } = opts
  if ((!contractId && !projectId) || !from || !to) return null
  const conds: string[] = ["invoice_status <> 'Cancelled'", "invoice_type NOT IN ('Credit Note','Proforma Invoice')"]
  const args: any[] = []
  if (contractId) {
    conds.push("contract_id = ?")
    args.push(contractId)
  }
  if (projectId) {
    conds.push("project_id = ?")
    args.push(projectId)
  }
  if (milestoneId) {
    conds.push("milestone_id = ?")
    args.push(milestoneId)
  }
  // Overlapping billing period for the same source.
  conds.push("billing_period_from IS NOT NULL AND billing_period_to IS NOT NULL")
  conds.push("billing_period_from <= ? AND billing_period_to >= ?")
  args.push(to, from)
  if (excludeInvoicePk) {
    conds.push("id <> ?")
    args.push(excludeInvoicePk)
  }
  const rows = await safe(
    () =>
      query(
        `SELECT invoice_id, invoice_date FROM sales_invoices WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT 1`,
        args,
      ) as Promise<any[]>,
    [],
  )
  return rows?.[0] ?? null
}

/**
 * Run all source-driven checks for a create/update. Returns any warnings found;
 * the route decides whether to block based on the `allow_overbilling` override.
 */
export async function runSourceChecks(opts: {
  clientName?: string
  contractId?: string
  quotationId?: string
  projectId?: string
  milestoneId?: string
  invoiceType?: string
  attemptedTotal: number
  billingFrom?: string
  billingTo?: string
  excludeInvoicePk?: number
}): Promise<BillingCheck> {
  const result: BillingCheck = {}

  const consistency = await consistencyError(
    opts.clientName || "",
    opts.contractId,
    opts.quotationId,
    opts.projectId,
  )
  if (consistency) result.consistency = consistency

  // Over-billing: only meaningful for revenue documents linked to a valued source.
  const isReducing = opts.invoiceType === "Credit Note"
  if (!isReducing) {
    for (const [kind, id] of [
      ["contract", opts.contractId],
      ["quotation", opts.quotationId],
    ] as Array<[SourceKind, string | undefined]>) {
      if (!id) continue
      const resolved = await resolveSource(kind, id, opts.excludeInvoicePk)
      if (resolved?.billing && resolved.billing.billable > 0) {
        const projected = round2(resolved.billing.invoiced + opts.attemptedTotal)
        if (projected > resolved.billing.billable + 0.01) {
          result.overbilling = {
            kind,
            billable: resolved.billing.billable,
            invoiced: resolved.billing.invoiced,
            remaining: resolved.billing.remaining,
            attempted: round2(opts.attemptedTotal),
          }
          break
        }
      }
    }
  }

  const dupe = await duplicateBilling({
    clientName: opts.clientName,
    contractId: opts.contractId,
    projectId: opts.projectId,
    milestoneId: opts.milestoneId,
    from: opts.billingFrom,
    to: opts.billingTo,
    excludeInvoicePk: opts.excludeInvoicePk,
  })
  if (dupe) result.duplicate = { invoice_id: dupe.invoice_id, invoice_date: dupe.invoice_date }

  return result
}

// ---------------------------------------------------------------------------
// Customer credit profile (spec 10–11)
// ---------------------------------------------------------------------------

export async function creditProfile(clientName: string, creditLimit: number | null) {
  const name = clientName?.trim()
  if (!name) return null
  const [row] = await safe(
    () =>
      query(
        `SELECT
           COALESCE(SUM(outstanding_amount),0) AS outstanding,
           COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE()
                             AND payment_status <> 'Paid' THEN outstanding_amount ELSE 0 END),0) AS overdue
         FROM sales_invoices
         WHERE client_name = ? AND invoice_status IN ('Issued','Sent','Posted')`,
        [name],
      ) as Promise<any[]>,
    [],
  )
  const outstanding = round2(num(row?.outstanding))
  const overdue = round2(num(row?.overdue))
  const limit = creditLimit != null ? round2(num(creditLimit)) : null
  return {
    credit_limit: limit,
    outstanding,
    overdue,
    available: limit != null ? round2(limit - outstanding) : null,
  }
}
