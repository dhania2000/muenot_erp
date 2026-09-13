import "server-only"
import { query } from "@/lib/db"

/**
 * Centralized TDS Rule Master (Phases 21–23, 39).
 *
 * TDS rates are NEVER hard-coded into the expense/bill engines. Instead they are
 * resolved from this single, effective-dated, configurable master keyed by
 * statutory section + nature of payment + deductee entity type. Every resolved
 * rule carries a version + effective window so a posted document can freeze the
 * exact rule that applied (Phase 38/39 — a later rate change never rewrites
 * history).
 *
 * The schema is self-creating + idempotent and seeds the common FY 2024-25+
 * sections so a fresh database is immediately usable. Rows can be edited /
 * extended through the TDS-rules API without code changes.
 */

export const TDS_ENTITY_TYPES = ["Company", "Individual/HUF", "Firm", "Any"] as const
export type TdsEntityType = (typeof TDS_ENTITY_TYPES)[number]

export type TdsRule = {
  id: number
  section: string
  nature_of_payment: string
  entity_type: string
  rate: number
  rate_no_pan: number
  threshold_single: number
  threshold_annual: number
  effective_from: string | null
  effective_to: string | null
  rule_version: string
  status: string
}

let ensured = false

export async function ensureTdsRuleMaster() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS finance_tds_rules (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      section VARCHAR(20) NOT NULL,
      nature_of_payment VARCHAR(190) NOT NULL,
      entity_type VARCHAR(30) NOT NULL DEFAULT 'Any',
      rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      rate_no_pan DECIMAL(6,2) NOT NULL DEFAULT 20,
      threshold_single DECIMAL(14,2) NOT NULL DEFAULT 0,
      threshold_annual DECIMAL(14,2) NOT NULL DEFAULT 0,
      effective_from DATE DEFAULT NULL,
      effective_to DATE DEFAULT NULL,
      rule_version VARCHAR(20) NOT NULL DEFAULT 'v1',
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tdsrule_section (section),
      KEY idx_tdsrule_status (status),
      KEY idx_tdsrule_entity (entity_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await seedIfEmpty()
  ensured = true
}

async function seedIfEmpty() {
  const rows = (await query(`SELECT COUNT(*) AS c FROM finance_tds_rules`)) as any[]
  if (Number(rows?.[0]?.c ?? 0) > 0) return

  // section, nature, entity, rate, rate_no_pan, threshold_single, threshold_annual
  const seed: Array<[string, string, TdsEntityType, number, number, number, number]> = [
    ["194C", "Payment to contractors", "Individual/HUF", 1, 20, 30000, 100000],
    ["194C", "Payment to contractors", "Company", 2, 20, 30000, 100000],
    ["194C", "Payment to contractors", "Firm", 2, 20, 30000, 100000],
    ["194C", "Payment to contractors", "Any", 2, 20, 30000, 100000],
    ["194J", "Professional / technical fees", "Any", 10, 20, 30000, 30000],
    ["194J-T", "Technical services fees", "Any", 2, 20, 30000, 30000],
    ["194H", "Commission or brokerage", "Any", 2, 20, 15000, 15000],
    ["194I-a", "Rent — plant & machinery", "Any", 2, 20, 0, 240000],
    ["194I-b", "Rent — land / building / furniture", "Any", 10, 20, 0, 240000],
    ["194Q", "Purchase of goods", "Any", 0.1, 5, 0, 5000000],
    ["194A", "Interest (other than securities)", "Any", 10, 20, 0, 40000],
    ["194D", "Insurance commission", "Any", 5, 20, 0, 15000],
    ["194G", "Commission on lottery tickets", "Any", 2, 20, 0, 15000],
    ["194", "Dividend", "Any", 10, 20, 0, 5000],
  ]
  for (const [section, nature, entity, rate, rateNoPan, single, annual] of seed) {
    await query(
      `INSERT INTO finance_tds_rules
         (section, nature_of_payment, entity_type, rate, rate_no_pan, threshold_single, threshold_annual, effective_from, rule_version, status)
       VALUES (?,?,?,?,?,?,?, '2024-04-01', 'FY2024-25', 'Active')`,
      [section, nature, entity, rate, rateNoPan, single, annual],
    )
  }
}

const norm = (v: any) => String(v ?? "").trim()

/** Map a vendor's business constitution to a TDS deductee entity type. */
export function entityTypeForConstitution(constitution?: string | null): TdsEntityType {
  const c = norm(constitution).toLowerCase()
  if (!c) return "Any"
  if (c.includes("individual") || c.includes("proprietor") || c.includes("huf")) return "Individual/HUF"
  if (c.includes("company") || c.includes("private") || c.includes("public") || c.includes("llp")) return "Company"
  if (c.includes("firm") || c.includes("partnership")) return "Firm"
  return "Any"
}

/**
 * Resolve the applicable TDS rule for a section + entity + date (Phase 21–23).
 * Prefers an exact entity-type match over the generic "Any" fallback, and the
 * most-recent effective rule when several versions overlap. Returns null when
 * no active rule matches, so the caller can fall back to any explicit rate.
 */
export async function resolveTdsRule(opts: {
  section?: string | null
  entityType?: string | null
  date?: string | null
}): Promise<TdsRule | null> {
  const section = norm(opts.section)
  if (!section) return null
  await ensureTdsRuleMaster()

  const date = norm(opts.date) ? norm(opts.date).slice(0, 10) : new Date().toISOString().slice(0, 10)
  const entity = norm(opts.entityType) || "Any"

  const rows = (await query(
    `SELECT * FROM finance_tds_rules
       WHERE section = ? AND status = 'Active'
         AND (entity_type = ? OR entity_type = 'Any')
         AND (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY (entity_type = ?) DESC, effective_from DESC
       LIMIT 1`,
    [section, entity, date, date, entity],
  )) as any[]
  if (!rows[0]) return null
  const r = rows[0]
  return {
    id: Number(r.id),
    section: r.section,
    nature_of_payment: r.nature_of_payment,
    entity_type: r.entity_type,
    rate: Number(r.rate),
    rate_no_pan: Number(r.rate_no_pan),
    threshold_single: Number(r.threshold_single),
    threshold_annual: Number(r.threshold_annual),
    effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
    effective_to: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
    rule_version: r.rule_version,
    status: r.status,
  }
}

export async function listTdsRules(activeOnly = false): Promise<TdsRule[]> {
  await ensureTdsRuleMaster()
  const rows = (await query(
    `SELECT * FROM finance_tds_rules ${activeOnly ? "WHERE status = 'Active'" : ""}
       ORDER BY section ASC, entity_type ASC, effective_from DESC`,
  )) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    section: r.section,
    nature_of_payment: r.nature_of_payment,
    entity_type: r.entity_type,
    rate: Number(r.rate),
    rate_no_pan: Number(r.rate_no_pan),
    threshold_single: Number(r.threshold_single),
    threshold_annual: Number(r.threshold_annual),
    effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
    effective_to: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
    rule_version: r.rule_version,
    status: r.status,
  }))
}
