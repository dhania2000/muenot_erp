import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { ensureContractTables, getCompanySettings } from "@/lib/legal-contracts-db"
import { resolveContractVariables, formatContractDate } from "@/lib/legal-contract-variables"
import { renderContractTemplate, missingRequiredValues } from "@/lib/legal-contracts-render"
import { getContractTemplate } from "@/lib/legal-contracts-templates"
import { logContractEvent } from "@/lib/legal-contracts-audit"
import { sourceMeta, type GeneratedContract } from "@/lib/legal-contracts-shared"

// ---------------------------------------------------------------------------
// Legal Contracts — generation orchestrator (server-only).
//
// Resolves variables for the chosen source record, renders the template body,
// snapshots the merged variable map, dedupes source-bound contracts, and
// persists a row in legal_generated_contracts. Mirrors hr-letters-generate.
// ---------------------------------------------------------------------------

export type GenerateContractInput = {
  templateId?: number | null
  title?: string | null
  contractType?: string | null
  category?: string | null
  source: string
  sourceRef?: string | null
  contentOverride?: string | null
  effectiveDate?: string | null
  startDate?: string | null
  endDate?: string | null
  renewalDate?: string | null
  manualVars?: Record<string, string>
  status?: string
  allowMissing?: boolean
  supersedesId?: number | null
  /** Status to set on the superseded contract. Defaults to "Cancelled". */
  supersedeStatus?: string
  /** Audit event type to record. Defaults to "contract_generated". */
  auditType?: "contract_generated" | "contract_renewed"
  actorId?: number | null
  actorName?: string | null
}

export type GenerateResult =
  | { ok: true; contract: GeneratedContract; deduped?: boolean }
  | { ok: false; error: string; code: number; missing?: string[] }

export async function generateContract(input: GenerateContractInput): Promise<GenerateResult> {
  await ensureContractTables()

  const template = input.templateId ? await getContractTemplate(input.templateId) : null
  const contentTpl = input.contentOverride ?? template?.content ?? ""
  if (!contentTpl.trim()) return { ok: false, error: "A template or content is required", code: 400 }

  const source = input.source || template?.source || "manual"
  const contractType = input.contractType || template?.contract_type || "Other"
  const category = input.category || template?.category || null
  const title = (input.title || template?.name || contractType || "Agreement").trim()

  const contractUid = await nextRecordId("CONT")
  const settings = await getCompanySettings()
  const referenceNo = await nextContractReference(settings)

  const resolved = await resolveContractVariables({
    source,
    sourceRef: input.sourceRef,
    manualVars: input.manualVars,
    meta: {
      contractId: contractUid,
      referenceNo,
      title,
      effectiveDate: input.effectiveDate || input.startDate || undefined,
      startDate: input.startDate || undefined,
      endDate: input.endDate || undefined,
      renewalDate: input.renewalDate || undefined,
      generatedBy: input.actorName || undefined,
    },
  })

  // Required-variable completeness from the template definition.
  if (!input.allowMissing && template?.required_variables?.length) {
    const missing = missingRequiredValues(template.required_variables, resolved.vars)
    if (missing.length) return { ok: false, error: "Missing required values", code: 422, missing }
  }

  const content = renderContractTemplate(contentTpl, resolved.vars)
  const status = input.status || "Generated"

  const meta = sourceMeta(source)
  const partyType = resolved.partyType || (source === "manual" ? "manual" : source)
  const partyName = resolved.partyName || resolved.vars.party_name || null

  // Dedupe source-bound contracts by (template, source, sourceRef).
  const dedupeKey =
    source !== "manual" && input.sourceRef
      ? crypto
          .createHash("sha1")
          .update([input.templateId ?? "", source, input.sourceRef].join("|"))
          .digest("hex")
      : null

  if (dedupeKey && !input.supersedesId) {
    const existing = await query<any[]>(
      "SELECT id FROM legal_generated_contracts WHERE dedupe_key = ? AND status NOT IN ('Cancelled','Terminated') LIMIT 1",
      [dedupeKey],
    )
    if (existing[0]) {
      const contract = await getGeneratedContract(Number(existing[0].id))
      if (contract) return { ok: true, contract, deduped: true }
    }
  }

  const result = await query<any>(
    `INSERT INTO legal_generated_contracts
      (contract_uid, reference_no, title, template_id, template_version, contract_type, category,
       source, source_ref, party_type, party_name, content, status, version,
       effective_date, start_date, end_date, renewal_date, variables_snapshot,
       supersedes_id, dedupe_key, generated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      contractUid,
      referenceNo,
      title,
      input.templateId ?? null,
      template?.version ?? null,
      contractType,
      category,
      source,
      input.sourceRef ?? null,
      partyType,
      partyName,
      content,
      status,
      1,
      input.effectiveDate || input.startDate || null,
      input.startDate || null,
      input.endDate || null,
      input.renewalDate || null,
      JSON.stringify(resolved.vars),
      input.supersedesId ?? null,
      dedupeKey,
      input.actorId ?? null,
    ],
  )
  const newId = Number((result as any).insertId)

  if (input.supersedesId) {
    await query(
      "UPDATE legal_generated_contracts SET superseded_by = ?, status = ? WHERE id = ?",
      [newId, input.supersedeStatus || "Cancelled", input.supersedesId],
    ).catch(() => {})
  }

  if (input.templateId) {
    await query(
      "UPDATE legal_contract_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?",
      [input.templateId],
    ).catch(() => {})
  }

  const contract = await getGeneratedContract(newId)
  if (!contract) return { ok: false, error: "Failed to load created contract", code: 500 }

  await logContractEvent({
    entity: "contract",
    entityId: newId,
    entityRef: contract.reference_no || contract.contract_uid,
    type: input.auditType || "contract_generated",
    summary:
      input.auditType === "contract_renewed"
        ? `Renewed from contract #${input.supersedesId}`
        : `Generated ${contract.contract_type} “${contract.title}”`,
    detail: {
      templateId: input.templateId ?? null,
      templateVersion: template?.version ?? null,
      source,
      sourceRef: input.sourceRef ?? null,
      party: partyName,
    },
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
  })

  void meta
  return { ok: true, contract }
}

/** Formal contract reference number, e.g. MUENOT/LEGAL/2026/000012. */
async function nextContractReference(settings: Record<string, string>): Promise<string> {
  const prefix =
    settings["contract.reference_prefix"] ||
    settings["company.short_name"] ||
    (settings["company.name"] || settings["company_name"] || "MUENOT").split(/\s+/)[0]?.toUpperCase() ||
    "MUENOT"
  const year = new Date().getFullYear()
  try {
    const seq = await nextRecordId(`${prefix}LEGAL${year}`, { digits: 6, allowCustom: true })
    const number = seq.split("-").pop() || "000001"
    return `${prefix}/LEGAL/${year}/${number}`
  } catch {
    return `${prefix}/LEGAL/${year}/${String(Date.now()).slice(-6)}`
  }
}

function parseSnapshot(value: any): Record<string, string> | null {
  if (!value) return null
  if (typeof value === "object") return value as Record<string, string>
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

export async function getGeneratedContract(id: number): Promise<GeneratedContract | null> {
  await ensureContractTables()
  const rows = await query<any[]>(
    `SELECT c.*, t.name AS template_name, u.name AS generated_by_name
       FROM legal_generated_contracts c
       LEFT JOIN legal_contract_templates t ON t.id = c.template_id
       LEFT JOIN users u ON u.id = c.generated_by
      WHERE c.id = ? LIMIT 1`,
    [id],
  ).catch(async () => {
    // users table name/columns vary; fall back to no join.
    return query<any[]>(
      `SELECT c.*, t.name AS template_name FROM legal_generated_contracts c
         LEFT JOIN legal_contract_templates t ON t.id = c.template_id WHERE c.id = ? LIMIT 1`,
      [id],
    )
  })
  const r = rows[0]
  if (!r) return null
  return { ...r, variables_snapshot: parseSnapshot(r.variables_snapshot) } as GeneratedContract
}

export type ContractListFilters = {
  search?: string
  status?: string
  source?: string
  contractType?: string
  limit?: number
  offset?: number
}

export async function listGeneratedContracts(filters: ContractListFilters = {}): Promise<{
  rows: GeneratedContract[]
  total: number
}> {
  await ensureContractTables()
  const where: string[] = []
  const params: any[] = []
  if (filters.search) {
    where.push("(c.title LIKE ? OR c.contract_uid LIKE ? OR c.reference_no LIKE ? OR c.party_name LIKE ?)")
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }
  if (filters.status && filters.status !== "all") {
    where.push("c.status = ?")
    params.push(filters.status)
  }
  if (filters.source && filters.source !== "all") {
    where.push("c.source = ?")
    params.push(filters.source)
  }
  if (filters.contractType && filters.contractType !== "all") {
    where.push("c.contract_type = ?")
    params.push(filters.contractType)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
  const offset = Math.max(filters.offset ?? 0, 0)

  const rows = await query<any[]>(
    `SELECT c.*, t.name AS template_name
       FROM legal_generated_contracts c
       LEFT JOIN legal_contract_templates t ON t.id = c.template_id
       ${whereSql}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  const countRows = await query<any[]>(
    `SELECT COUNT(*) AS n FROM legal_generated_contracts c ${whereSql}`,
    params,
  )
  return {
    rows: rows.map((r) => ({ ...r, variables_snapshot: parseSnapshot(r.variables_snapshot) })) as GeneratedContract[],
    total: Number(countRows[0]?.n || 0),
  }
}

/** Aggregate counts for the Generated tab summary cards (Phase 95). */
export async function contractStats(): Promise<{
  total: number
  active: number
  pending: number
  draft: number
  signed: number
  expiringSoon: number
  expired: number
  renewalDue: number
}> {
  await ensureContractTables()
  const rows = await query<any[]>(
    `SELECT
        COUNT(*) AS total,
        SUM(status IN ('Active','Signed')) AS active,
        SUM(status IN ('Generated','In Review')) AS pending,
        SUM(status = 'Draft') AS draft,
        SUM(status = 'Signed') AS signed,
        SUM(status = 'Expired') AS expired,
        SUM(status NOT IN ('Expired','Terminated','Cancelled') AND end_date IS NOT NULL
            AND end_date >= CURDATE() AND end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS expiring_soon,
        SUM(status NOT IN ('Expired','Terminated','Cancelled') AND renewal_date IS NOT NULL
            AND renewal_date >= CURDATE() AND renewal_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS renewal_due
       FROM legal_generated_contracts`,
  ).catch(() => [{}])
  const r = rows[0] || {}
  return {
    total: Number(r.total || 0),
    active: Number(r.active || 0),
    pending: Number(r.pending || 0),
    draft: Number(r.draft || 0),
    signed: Number(r.signed || 0),
    expiringSoon: Number(r.expiring_soon || 0),
    expired: Number(r.expired || 0),
    renewalDue: Number(r.renewal_due || 0),
  }
}

/** Build the PDF party blocks + company profile for a generated contract. */
export async function contractPdfContext(contract: GeneratedContract) {
  const settings = await getCompanySettings()
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = settings[k]
      if (v != null && String(v).trim() !== "") return String(v)
    }
    return ""
  }
  const company = {
    name: pick("company.name", "company_name", "legal_name", "name") || "Company",
    address: pick("company.address", "company_address", "address"),
    email: pick("company.email", "company_email", "email"),
    phone: pick("company.phone", "company_phone", "phone"),
    website: pick("company.website", "company_website", "website"),
  }
  const snap = contract.variables_snapshot || {}
  const firstParty = {
    role: `For ${company.name}`,
    name: snap.authorized_signatory || pick("contract.signatory_name", "letter.signatory_name") || null,
    meta: snap.signatory_designation || pick("contract.signatory_designation", "letter.signatory_designation") || null,
  }
  const secondParty = {
    role: contract.party_type && contract.party_type !== "manual" ? sourceMeta(contract.party_type).partyRole : "Counterparty",
    name: contract.party_name || snap.party_name || null,
    meta:
      snap.client_gstin ||
      snap.vendor_gstin ||
      snap.party_gstin ||
      snap.client_email ||
      snap.vendor_email ||
      snap.party_email ||
      null,
  }
  return { company, firstParty, secondParty, effectiveDate: contract.effective_date || contract.start_date }
}

export { formatContractDate }
