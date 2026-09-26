/**
 * Reviewed import adapter catalog (pure, testable).
 * ---------------------------------------------------------------------------
 * Spec48 (#41-42, #98). Enterprises rarely hand us a file already shaped like a
 * Muenot import template — they export from Tally, an HRMS or a CRM, each with
 * its own column names and quirks. An ADAPTER is a REVIEWED, declarative mapping
 * from one such external document to an existing importable dataset
 * (lib/import-configs.ts). It does NOT introduce a new import pipeline: it only
 * renames/normalizes columns so the vendor file can flow through the exact same
 * map → validate → dedupe → commit pipeline every other import uses.
 *
 * Everything here is data + pure functions (no `server-only`, Node or DB), so
 * the registry is safe to project to the client mapping UI and to unit-test.
 *
 * Security: adapters neutralize spreadsheet formulas on ingest (see
 * neutralizeFormula) so a crafted `=cmd|...` cell can never be stored and later
 * re-exported as a live formula.
 */

import { getImportDataset, getPublicImportDataset } from "@/lib/data-import-catalog"
import { neutralizeFormula } from "@/lib/data-import-batches-model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ADAPTER_SOURCES = ["tally", "hrms", "crm"] as const
export type AdapterSource = (typeof ADAPTER_SOURCES)[number]

export const ADAPTER_SOURCE_LABELS: Record<AdapterSource, string> = {
  tally: "Tally",
  hrms: "HRMS",
  crm: "CRM",
}

export type ImportAdapter = {
  /** Stable adapter id used by the API + job records (e.g. "tally.sales-vouchers"). */
  key: string
  source: AdapterSource
  label: string
  description: string
  /** Target importable dataset key in IMPORT_CONFIGS. */
  datasetKey: string
  /**
   * Vendor header (matched case/space/punctuation-insensitively) → target
   * column key. Multiple vendor spellings may map to the same target column;
   * the first non-empty source value wins.
   */
  fieldMap: Record<string, string>
  /**
   * Optional per-row derivation run AFTER field mapping, keyed by target
   * column. Receives the mapped row (target keys) and returns a value. Used for
   * light shaping (e.g. defaulting a missing invoice total from an amount).
   * Must stay pure.
   */
  derive?: Record<string, (mapped: Record<string, string>) => string | undefined>
}

function norm(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

// ---------------------------------------------------------------------------
// The reviewed registry
// ---------------------------------------------------------------------------

export const IMPORT_ADAPTERS: ImportAdapter[] = [
  // --- Tally --------------------------------------------------------------
  {
    key: "tally.party-ledgers",
    source: "tally",
    label: "Tally — Party Ledgers",
    description: "Tally ledger master export (sundry debtors/creditors) mapped to Client master records.",
    datasetKey: "clients",
    fieldMap: {
      "Ledger Name": "client_name",
      Name: "client_name",
      "Mailing Name": "legal_name",
      Email: "email",
      "Email ID": "email",
      "Phone No": "mobile",
      Mobile: "mobile",
      "Contact Number": "mobile",
      GSTIN: "gst_number",
      "GST Number": "gst_number",
      "GST/UIN": "gst_number",
      "PAN/IT No": "pan",
      PAN: "pan",
      Address: "address",
      City: "city",
      State: "state",
      Country: "country",
      Pincode: "postal_code",
      "PIN Code": "postal_code",
      "Credit Limit": "credit_limit",
      "Credit Period": "payment_terms_days",
    },
  },
  {
    key: "tally.sales-vouchers",
    source: "tally",
    label: "Tally — Sales Vouchers",
    description: "Tally sales voucher / day-book export mapped to Sales Invoices.",
    datasetKey: "finance-sales-invoices",
    fieldMap: {
      Date: "invoice_date",
      "Voucher Date": "invoice_date",
      "Party Ledger": "client_name",
      "Party Name": "client_name",
      Party: "client_name",
      "Voucher No": "payment_reference",
      "Voucher Number": "payment_reference",
      "GSTIN/UIN": "irn_reference",
      "Taxable Value": "taxable_amount",
      "Taxable Amount": "taxable_amount",
      "Gross Total": "invoice_total",
      Amount: "invoice_total",
      "Invoice Amount": "invoice_total",
      "CGST Amount": "cgst_amount",
      "SGST Amount": "sgst_amount",
      "IGST Amount": "igst_amount",
      Narration: "notes",
    },
    derive: {
      // Tally day-books often carry only a gross "Amount"; seed taxable from it
      // when a discrete taxable value is absent so the required money columns
      // are never empty.
      taxable_amount: (m) => (m.taxable_amount?.trim() ? undefined : m.invoice_total),
    },
  },
  // --- HRMS ---------------------------------------------------------------
  {
    key: "hrms.attendance",
    source: "hrms",
    label: "HRMS — Attendance",
    description: "Biometric / HRMS daily attendance export mapped to HR Attendance.",
    datasetKey: "hr-attendance",
    fieldMap: {
      "Employee ID": "employee_id",
      "Emp Code": "employee_id",
      "Employee Code": "employee_id",
      EmpID: "employee_id",
      "Employee Name": "employee_name",
      Name: "employee_name",
      Date: "work_date",
      "Attendance Date": "work_date",
      "In Time": "clock_in",
      "Punch In": "clock_in",
      "Out Time": "clock_out",
      "Punch Out": "clock_out",
      "Break (min)": "break_minutes",
      "Break Minutes": "break_minutes",
      Status: "status",
      Remarks: "remarks",
    },
  },
  {
    key: "hrms.leave-requests",
    source: "hrms",
    label: "HRMS — Leave Requests",
    description: "HRMS leave application export mapped to HR Leave Requests.",
    datasetKey: "hr-leave-requests",
    fieldMap: {
      "Employee ID": "employee_id",
      "Emp Code": "employee_id",
      "Employee Name": "employee_name",
      "Leave Type": "leave_type_id",
      "Leave Code": "leave_type_id",
      "From Date": "from_date",
      "Start Date": "from_date",
      "To Date": "to_date",
      "End Date": "to_date",
      Days: "days",
      "No of Days": "days",
      Reason: "reason",
      Status: "status",
    },
  },
  // --- CRM ----------------------------------------------------------------
  {
    key: "crm.accounts",
    source: "crm",
    label: "CRM — Accounts / Contacts",
    description: "CRM account & contact export (Salesforce/HubSpot/Zoho style) mapped to Client master.",
    datasetKey: "clients",
    fieldMap: {
      "Account Name": "client_name",
      "Company Name": "company_name",
      "Full Name": "client_name",
      Name: "client_name",
      Email: "email",
      "Email Address": "email",
      Phone: "mobile",
      "Mobile Phone": "mobile",
      "Phone Number": "mobile",
      Website: "website",
      "Billing City": "city",
      City: "city",
      "Billing State": "state",
      State: "state",
      "Billing Country": "country",
      Country: "country",
      "Billing Zip": "postal_code",
      "Postal Code": "postal_code",
      Industry: "category",
    },
  },
  {
    key: "crm.deals",
    source: "crm",
    label: "CRM — Deals / Opportunities",
    description: "CRM deal / opportunity pipeline export mapped to Sales Quotations.",
    datasetKey: "sales-quotations",
    fieldMap: {
      "Deal Name": "opportunity_name",
      "Opportunity Name": "opportunity_name",
      "Account Name": "company_name",
      Company: "company_name",
      "Contact Name": "contact_person",
      "Primary Contact": "contact_person",
      Amount: "total_amount",
      "Deal Value": "total_amount",
      Value: "total_amount",
      "Closing Date": "valid_until",
      "Close Date": "valid_until",
      "Create Date": "quote_date",
      "Created Date": "quote_date",
      Stage: "status",
      "Deal Stage": "status",
    },
  },
]

// ---------------------------------------------------------------------------
// Lookup + public projection
// ---------------------------------------------------------------------------

export function getImportAdapter(key: string): ImportAdapter | undefined {
  return IMPORT_ADAPTERS.find((a) => a.key === key)
}

export type PublicImportAdapter = {
  key: string
  source: AdapterSource
  sourceLabel: string
  label: string
  description: string
  datasetKey: string
  datasetLabel: string
  /** Vendor headers this adapter recognizes, for the "expected columns" hint. */
  sourceHeaders: string[]
  /** Whether the target dataset is importable in this deployment. */
  available: boolean
}

function projectAdapter(adapter: ImportAdapter): PublicImportAdapter {
  const dataset = getPublicImportDataset(adapter.datasetKey)
  return {
    key: adapter.key,
    source: adapter.source,
    sourceLabel: ADAPTER_SOURCE_LABELS[adapter.source],
    label: adapter.label,
    description: adapter.description,
    datasetKey: adapter.datasetKey,
    datasetLabel: dataset ? `${dataset.label} · ${dataset.module}` : adapter.datasetKey,
    sourceHeaders: Object.keys(adapter.fieldMap),
    available: Boolean(dataset),
  }
}

/** Client-safe adapter catalog, grouped-friendly (sorted by source then label). */
export function adapterCatalogForClient(): PublicImportAdapter[] {
  return IMPORT_ADAPTERS.map(projectAdapter).sort(
    (a, b) => a.source.localeCompare(b.source) || a.label.localeCompare(b.label),
  )
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

export type AdapterResult = {
  datasetKey: string
  /** Target column keys used as headers (the transformed rows are keyed by them). */
  headers: string[]
  /** Rows keyed by TARGET column key, formula-neutralized and ready to import. */
  rows: Record<string, string>[]
  /** Identity mapping (target key → target key) for the import pipeline. */
  mapping: Record<string, string>
  /** Vendor headers present in the file that the adapter did not recognize. */
  unmappedSourceHeaders: string[]
}

/**
 * Apply an adapter to raw vendor rows (each keyed by its raw header text),
 * producing pipeline-ready rows keyed by target column. The result plugs
 * directly into analyzeImport/commit with an identity mapping. Pure.
 */
export function applyAdapter(adapter: ImportAdapter, rawRows: Record<string, unknown>[]): AdapterResult {
  // Build a normalized vendor-header → target-key lookup once.
  const lookup = new Map<string, string>()
  for (const [vendorHeader, targetKey] of Object.entries(adapter.fieldMap)) {
    lookup.set(norm(vendorHeader), targetKey)
  }

  const targetKeys = new Set<string>(Object.values(adapter.fieldMap))
  const unmapped = new Set<string>()
  const rows: Record<string, string>[] = []

  for (const raw of rawRows) {
    const mapped: Record<string, string> = {}
    for (const [rawHeader, value] of Object.entries(raw)) {
      const targetKey = lookup.get(norm(rawHeader))
      if (!targetKey) {
        if (String(rawHeader).trim() !== "") unmapped.add(rawHeader)
        continue
      }
      const str = value == null ? "" : String(value).trim()
      // First non-empty source value wins when several vendor headers collapse
      // onto one target column.
      if (str !== "" && (mapped[targetKey] == null || mapped[targetKey] === "")) {
        mapped[targetKey] = neutralizeFormula(str) as string
      } else if (mapped[targetKey] == null) {
        mapped[targetKey] = ""
      }
    }
    if (adapter.derive) {
      for (const [targetKey, fn] of Object.entries(adapter.derive)) {
        const derived = fn(mapped)
        if (derived != null && derived !== "") {
          mapped[targetKey] = neutralizeFormula(String(derived)) as string
          targetKeys.add(targetKey)
        }
      }
    }
    rows.push(mapped)
  }

  const headers = Array.from(targetKeys)
  const mapping: Record<string, string> = {}
  for (const key of headers) mapping[key] = key

  return {
    datasetKey: adapter.datasetKey,
    headers,
    rows,
    mapping,
    unmappedSourceHeaders: Array.from(unmapped),
  }
}

/** Whether an adapter's target dataset is importable in this deployment. */
export function isAdapterAvailable(adapter: ImportAdapter): boolean {
  return Boolean(getImportDataset(adapter.datasetKey))
}
