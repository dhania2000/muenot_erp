import "server-only"
/**
 * SPEC 92 — Numbering Engine: rule store (Phase 2).
 * ---------------------------------------------------------------------------
 * Reads and writes the per-tenant, per-entity numbering RULES (format, prefix,
 * suffix, padding, reset policy…). Counters live in engine.ts; this file only
 * owns the configuration side.
 *
 * Every statement is tenant-scoped: the acting tenant is taken from the request
 * context (never from caller input), so one tenant can never read or mutate
 * another's numbering configuration.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureNumberingSchema } from "@/lib/numbering/schema"
import {
  type NumberingRule,
  type RuleInput,
  NUMBERING_ENTITIES,
  clampFiscalMonth,
  clampPadding,
  defaultRuleFor,
  normalizeEntity,
  renderNumber,
  validateRuleInput,
} from "@/lib/numbering/model"

type RuleRow = {
  entity: string
  prefix: string
  suffix: string
  padding: number
  reset_rule: string
  format: string
  fiscal_start_month: number
  start_number: number
  active: number
  updated_by: number | null
  updated_at: string | null
}

function rowToRule(row: RuleRow): NumberingRule {
  return {
    entity: normalizeEntity(row.entity),
    prefix: row.prefix ?? "",
    suffix: row.suffix ?? "",
    padding: clampPadding(Number(row.padding)),
    reset: (row.reset_rule as NumberingRule["reset"]) ?? "never",
    format: row.format,
    fiscalStartMonth: clampFiscalMonth(Number(row.fiscal_start_month)),
    startNumber: Math.max(0, Math.trunc(Number(row.start_number) || 1)),
  }
}

/** The raw stored rule row for an entity, or null when the tenant has none. */
export async function getRuleRow(entity: string): Promise<RuleRow | null> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const key = normalizeEntity(entity)
  const rows = (await query(
    `SELECT entity, prefix, suffix, padding, reset_rule, format, fiscal_start_month,
            start_number, active, updated_by, updated_at
       FROM numbering_rules
      WHERE tenant_id = ? AND entity = ?
      LIMIT 1`,
    [tenantId, key],
  )) as RuleRow[]
  return rows[0] ?? null
}

/**
 * The effective rule for an entity: the tenant's stored (active) rule when one
 * exists, otherwise the catalogue default. `custom` distinguishes the two so
 * the UI can show which entities have been tailored, and legacy call sites can
 * decide whether to route through the engine at all.
 */
export async function loadRule(
  entity: string,
): Promise<{ rule: NumberingRule; custom: boolean; active: boolean }> {
  const row = await getRuleRow(entity)
  if (row && Number(row.active) === 1) {
    return { rule: rowToRule(row), custom: true, active: true }
  }
  if (row) {
    // A saved-but-disabled rule falls back to the default for allocation, but we
    // still report it as custom+inactive so the console can surface the state.
    return { rule: defaultRuleFor(entity), custom: true, active: false }
  }
  return { rule: defaultRuleFor(entity), custom: false, active: true }
}

export type RuleListItem = {
  entity: string
  label: string
  module: string
  rule: NumberingRule
  custom: boolean
  active: boolean
  sample: string
}

/**
 * Every entity the console can configure: the built-in catalogue merged with
 * any stored rules (including custom entities not in the catalogue). Each item
 * carries a rendered sample so the list is self-explanatory.
 */
export async function listRules(sampleDate: Date = new Date()): Promise<RuleListItem[]> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT entity, prefix, suffix, padding, reset_rule, format, fiscal_start_month,
            start_number, active, updated_by, updated_at
       FROM numbering_rules
      WHERE tenant_id = ?`,
    [tenantId],
  )) as RuleRow[]

  const stored = new Map<string, RuleRow>()
  for (const row of rows) stored.set(normalizeEntity(row.entity), row)

  const items: RuleListItem[] = []
  const seen = new Set<string>()

  for (const def of NUMBERING_ENTITIES) {
    const row = stored.get(def.entity)
    const custom = !!row
    const active = row ? Number(row.active) === 1 : true
    const rule = row && active ? rowToRule(row) : { entity: def.entity, ...def.defaults }
    items.push({
      entity: def.entity,
      label: def.label,
      module: def.module,
      rule,
      custom,
      active,
      sample: renderNumber(rule, rule.startNumber, sampleDate),
    })
    seen.add(def.entity)
  }

  // Custom entities the tenant created that are not part of the catalogue.
  for (const [key, row] of stored) {
    if (seen.has(key)) continue
    const active = Number(row.active) === 1
    const rule = rowToRule(row)
    items.push({
      entity: key,
      label: key,
      module: "Custom",
      rule,
      custom: true,
      active,
      sample: renderNumber(rule, rule.startNumber, sampleDate),
    })
  }

  return items
}

/**
 * Validate and persist a rule (idempotent upsert on tenant+entity). Returns the
 * normalized rule that was stored, or the collected validation errors.
 */
export async function saveRule(
  input: RuleInput & { active?: boolean },
  updatedBy: number | null,
): Promise<{ ok: true; rule: NumberingRule } | { ok: false; errors: string[] }> {
  const parsed = validateRuleInput(input)
  if (!parsed.ok) return parsed

  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const rule = parsed.rule
  const active = input.active === false ? 0 : 1

  await query(
    `INSERT INTO numbering_rules
       (tenant_id, entity, prefix, suffix, padding, reset_rule, format,
        fiscal_start_month, start_number, active, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       prefix = VALUES(prefix),
       suffix = VALUES(suffix),
       padding = VALUES(padding),
       reset_rule = VALUES(reset_rule),
       format = VALUES(format),
       fiscal_start_month = VALUES(fiscal_start_month),
       start_number = VALUES(start_number),
       active = VALUES(active),
       updated_by = VALUES(updated_by)`,
    [
      tenantId,
      rule.entity,
      rule.prefix,
      rule.suffix,
      rule.padding,
      rule.reset,
      rule.format,
      rule.fiscalStartMonth,
      rule.startNumber,
      active,
      updatedBy,
    ],
  )

  return { ok: true, rule }
}

/**
 * Remove a tenant's custom rule for an entity, reverting it to the catalogue
 * default. Counters are intentionally left intact so numbering continuity is
 * preserved (use resetCounter in engine.ts to restart a sequence explicitly).
 */
export async function deleteRule(entity: string): Promise<boolean> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const key = normalizeEntity(entity)
  const res = (await query(`DELETE FROM numbering_rules WHERE tenant_id = ? AND entity = ?`, [
    tenantId,
    key,
  ])) as { affectedRows?: number }
  return (res?.affectedRows ?? 0) > 0
}
