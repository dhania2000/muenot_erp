import "server-only"
import { query, tableColumns } from "@/lib/db"
import { getCompanySettings } from "@/lib/legal-contracts-db"
import {
  type ContractSource,
  type ContractVariable,
  CONTRACT_SOURCES,
  variablesForSource,
} from "@/lib/legal-contracts-shared"

// ---------------------------------------------------------------------------
// Legal Contracts — server-side variable & source resolution.
//
// Resolves the primary source record (employee / client / vendor / candidate /
// project) plus the always-available company, contract-meta, user and date
// groups into a single flat variable map used by the render engine. Every
// source read is defensive: a missing table or column degrades to blanks
// instead of throwing, so the console keeps working even before every master
// module exists on a given install.
// ---------------------------------------------------------------------------

function pick(map: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map[k]
    if (v != null && String(v).trim() !== "") return String(v)
  }
  return ""
}

function joinAddress(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter(Boolean)
    .join(", ")
}

export function formatContractDate(value: string | Date | null | undefined): string {
  if (!value) return ""
  const d = typeof value === "string" ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

// --- Company group ----------------------------------------------------------
function companyVars(s: Record<string, string>): Record<string, string> {
  const address = joinAddress(
    pick(s, "company.address", "company_address", "address"),
    pick(s, "company.city", "city"),
    pick(s, "company.state", "state"),
    pick(s, "company.postal_code", "postal_code"),
  )
  return {
    company_name: pick(s, "company.name", "company_name", "legal_name", "name"),
    company_legal_name: pick(s, "company.legal_name", "legal_name", "company.name", "company_name"),
    company_address: address || pick(s, "company_address"),
    company_gstin: pick(s, "company.gstin", "company_gstin", "gstin", "gst_number"),
    company_pan: pick(s, "company.pan", "company_pan", "pan"),
    company_cin: pick(s, "company.cin", "company_cin", "cin"),
    company_email: pick(s, "company.email", "company_email", "email"),
    company_phone: pick(s, "company.phone", "company_phone", "phone", "mobile"),
    company_website: pick(s, "company.website", "company_website", "website"),
    authorized_signatory: pick(s, "contract.signatory_name", "letter.signatory_name", "signatory.name", "hr.signatory_name"),
    signatory_designation: pick(
      s,
      "contract.signatory_designation",
      "letter.signatory_designation",
      "signatory.designation",
      "hr.signatory_designation",
    ),
  }
}

// --- Source record readers --------------------------------------------------
export type SourceRecord = { id: string; label: string; sublabel?: string; raw: Record<string, any> }

const SOURCE_TABLE: Record<Exclude<ContractSource, "manual">, string> = {
  employee: "hr_employees",
  client: "clients",
  vendor: "finance_vendors",
  candidate: "recruitment_candidates",
  project: "operations_projects",
}

/** Candidate vendor tables, tried in order (installs differ). */
const VENDOR_TABLES = ["finance_vendors", "vendors", "finance_parties"]

async function firstExistingTable(candidates: string[]): Promise<string | null> {
  for (const t of candidates) {
    const cols = await tableColumns(t).catch(() => new Set<string>())
    if (cols.size > 0) return t
  }
  return null
}

async function vendorTable(): Promise<string | null> {
  return firstExistingTable(VENDOR_TABLES)
}

/** List records of a source for the picker (id, label, sublabel). */
export async function listSourceRecords(
  source: string,
  search: string,
  limit = 25,
): Promise<SourceRecord[]> {
  const s = source as ContractSource
  if (s === "manual" || !(CONTRACT_SOURCES as readonly string[]).includes(s)) return []
  const like = `%${search.trim()}%`
  try {
    if (s === "employee") {
      const rows = await query<any[]>(
        `SELECT id, employee_name, employee_id, designation, department, official_email
           FROM hr_employees
          WHERE (? = '' OR employee_name LIKE ? OR employee_id LIKE ?)
          ORDER BY employee_name LIMIT ?`,
        [search.trim(), like, like, limit],
      )
      return rows.map((r) => ({
        id: String(r.id),
        label: r.employee_name || `Employee #${r.id}`,
        sublabel: [r.employee_id, r.designation].filter(Boolean).join(" · "),
        raw: r,
      }))
    }
    if (s === "client") {
      const rows = await query<any[]>(
        `SELECT id, client_code, client_name, company_name, email, gst_number
           FROM clients
          WHERE (? = '' OR client_name LIKE ? OR company_name LIKE ? OR client_code LIKE ?)
          ORDER BY client_name LIMIT ?`,
        [search.trim(), like, like, like, limit],
      )
      return rows.map((r) => ({
        id: String(r.id),
        label: r.company_name || r.client_name || `Client #${r.id}`,
        sublabel: [r.client_code, r.client_name].filter(Boolean).join(" · "),
        raw: r,
      }))
    }
    if (s === "candidate") {
      const rows = await query<any[]>(
        `SELECT * FROM recruitment_candidates
          WHERE (? = '' OR name LIKE ? OR email LIKE ?)
          ORDER BY id DESC LIMIT ?`,
        [search.trim(), like, like, limit],
      )
      return rows.map((r) => ({
        id: String(r.id),
        label: r.name || r.candidate_name || `Candidate #${r.id}`,
        sublabel: [r.email, r.designation || r.position].filter(Boolean).join(" · "),
        raw: r,
      }))
    }
    if (s === "project") {
      const rows = await query<any[]>(
        `SELECT * FROM operations_projects
          WHERE (? = '' OR name LIKE ? OR project_id LIKE ?)
          ORDER BY id DESC LIMIT ?`,
        [search.trim(), like, like, limit],
      )
      return rows.map((r) => ({
        id: String(r.id),
        label: r.name || r.project_name || `Project #${r.id}`,
        sublabel: [r.project_id, r.client_name].filter(Boolean).join(" · "),
        raw: r,
      }))
    }
    if (s === "vendor") {
      const table = await vendorTable()
      if (!table) return []
      const cols = await tableColumns(table)
      const nameCol = ["vendor_name", "name", "party_name", "display_name"].find((c) => cols.has(c)) || "id"
      const rows = await query<any[]>(
        `SELECT * FROM ${table}
          WHERE (? = '' OR ${nameCol} LIKE ?)
          ORDER BY ${nameCol} LIMIT ?`,
        [search.trim(), like, limit],
      )
      return rows.map((r) => ({
        id: String(r.id),
        label: r[nameCol] || `Vendor #${r.id}`,
        sublabel: pick(r, "gst_number", "gstin", "email"),
        raw: r,
      }))
    }
  } catch (err) {
    console.error(`[legal-contract-variables] listSourceRecords ${source} failed`, err)
  }
  return []
}

async function fetchSourceRow(source: Exclude<ContractSource, "manual">, id: string): Promise<Record<string, any> | null> {
  try {
    const table = source === "vendor" ? await vendorTable() : SOURCE_TABLE[source]
    if (!table) return null
    const rows = await query<any[]>(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id])
    return rows[0] ?? null
  } catch (err) {
    console.error(`[legal-contract-variables] fetchSourceRow ${source}#${id} failed`, err)
    return null
  }
}

function mapSourceVars(source: ContractSource, r: Record<string, any>): Record<string, string> {
  switch (source) {
    case "employee":
      return {
        employee_name: pick(r, "employee_name", "name"),
        employee_id: pick(r, "employee_id", "employee_code"),
        designation: pick(r, "designation", "job_title"),
        department: pick(r, "department"),
        joining_date: formatContractDate(pick(r, "joining_date", "date_of_joining", "doj")),
        employment_type: pick(r, "employment_type", "employee_type"),
        work_email: pick(r, "official_email", "work_email", "email"),
        employee_phone: pick(r, "mobile", "phone", "contact_number"),
        employee_address: joinAddress(pick(r, "current_address", "address"), pick(r, "city"), pick(r, "state")),
        salary: pick(r, "ctc", "salary", "gross_salary", "annual_ctc"),
        date_of_birth: formatContractDate(pick(r, "date_of_birth", "dob")),
      }
    case "client":
      return {
        client_name: pick(r, "client_name", "primary_contact", "name"),
        client_legal_name: pick(r, "legal_name", "company_name", "client_name"),
        client_company: pick(r, "company_name", "client_name"),
        client_address: joinAddress(pick(r, "address"), pick(r, "city"), pick(r, "state"), pick(r, "postal_code")),
        client_gstin: pick(r, "gst_number", "gstin"),
        client_pan: pick(r, "pan"),
        client_email: pick(r, "email"),
        client_phone: pick(r, "mobile", "office_phone", "phone"),
      }
    case "vendor":
      return {
        vendor_name: pick(r, "vendor_name", "name", "party_name", "display_name"),
        vendor_legal_name: pick(r, "legal_name", "vendor_name", "name"),
        vendor_address: joinAddress(pick(r, "address"), pick(r, "city"), pick(r, "state"), pick(r, "postal_code")),
        vendor_gstin: pick(r, "gst_number", "gstin"),
        vendor_pan: pick(r, "pan"),
        vendor_email: pick(r, "email"),
        vendor_phone: pick(r, "mobile", "phone", "contact_number"),
      }
    case "candidate":
      return {
        candidate_name: pick(r, "name", "candidate_name", "full_name"),
        candidate_email: pick(r, "email"),
        candidate_phone: pick(r, "phone", "mobile", "contact_number"),
        offered_designation: pick(r, "designation", "position", "job_title", "applied_for"),
        offered_department: pick(r, "department"),
        offered_salary: pick(r, "offered_salary", "expected_salary", "ctc"),
        proposed_joining_date: formatContractDate(pick(r, "joining_date", "expected_joining_date")),
      }
    case "project":
      return {
        project_name: pick(r, "name", "project_name", "title"),
        project_id: pick(r, "project_id", "code"),
        project_client: pick(r, "client_name", "client"),
        project_start_date: formatContractDate(pick(r, "start_date", "kickoff_date")),
        project_end_date: formatContractDate(pick(r, "end_date", "due_date", "deadline")),
        project_scope: pick(r, "scope", "description", "summary"),
        project_manager: pick(r, "manager_name", "project_manager", "owner_name"),
      }
    default:
      return {}
  }
}

export type ContractMeta = {
  contractId?: string
  referenceNo?: string
  title?: string
  effectiveDate?: string
  startDate?: string
  endDate?: string
  renewalDate?: string
  generatedBy?: string
}

export type ResolvedVariables = {
  vars: Record<string, string>
  partyName: string | null
  partyType: string | null
  sourceRow: Record<string, any> | null
}

/**
 * Build the full flat variable map for a contract. `manualVars` supplies
 * counterparty fields (and any custom overrides) for the manual source and
 * always wins over resolved values.
 */
export async function resolveContractVariables(input: {
  source: string
  sourceRef?: string | null
  meta?: ContractMeta
  manualVars?: Record<string, string>
}): Promise<ResolvedVariables> {
  const source = ((CONTRACT_SOURCES as readonly string[]).includes(input.source) ? input.source : "manual") as ContractSource
  const settings = await getCompanySettings()
  const today = formatContractDate(new Date())

  const vars: Record<string, string> = {
    ...companyVars(settings),
    today,
    generated_by: input.meta?.generatedBy ?? "",
    contract_id: input.meta?.contractId ?? "",
    contract_reference: input.meta?.referenceNo ?? "",
    contract_title: input.meta?.title ?? "",
    contract_effective_date: formatContractDate(input.meta?.effectiveDate),
    contract_start_date: formatContractDate(input.meta?.startDate),
    contract_end_date: formatContractDate(input.meta?.endDate),
    contract_renewal_date: formatContractDate(input.meta?.renewalDate),
  }

  let sourceRow: Record<string, any> | null = null
  let partyName: string | null = null
  let partyType: string | null = null

  if (source !== "manual" && input.sourceRef) {
    sourceRow = await fetchSourceRow(source as Exclude<ContractSource, "manual">, input.sourceRef)
    if (sourceRow) {
      const mapped = mapSourceVars(source, sourceRow)
      Object.assign(vars, mapped)
      partyType = source
      partyName =
        mapped.client_company ||
        mapped.client_name ||
        mapped.vendor_name ||
        mapped.employee_name ||
        mapped.candidate_name ||
        mapped.project_name ||
        null
    }
  }

  // Manual / override values always take precedence.
  if (input.manualVars) {
    for (const [k, v] of Object.entries(input.manualVars)) {
      if (v != null && String(v).trim() !== "") vars[k] = String(v)
    }
    if (source === "manual") {
      partyType = "manual"
      partyName = input.manualVars.party_name || input.manualVars.party_legal_name || null
    }
  }

  return { vars, partyName, partyType, sourceRow }
}

/** The variable catalog for a source, merged with any custom DB-defined vars. */
export async function catalogForSource(source: string): Promise<ContractVariable[]> {
  const base = variablesForSource(source)
  try {
    const custom = await query<any[]>(
      `SELECT var_key, display_name, grp, data_source, required, example_value
         FROM legal_contract_variables
        WHERE is_builtin = 0 AND (data_source = ? OR data_source = 'any')`,
      [source],
    )
    const extra: ContractVariable[] = custom.map((c) => ({
      token: c.var_key,
      label: c.display_name,
      group: c.grp || "Custom",
      source: (c.data_source || "manual") as any,
      required: !!c.required,
      example: c.example_value || undefined,
    }))
    return [...extra, ...base]
  } catch {
    return base
  }
}
