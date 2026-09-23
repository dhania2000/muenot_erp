import "server-only"
/**
 * SPEC 70 — Field-Level Security (server store + request wiring).
 * ---------------------------------------------------------------------------
 * Replaces the frontend-only localStorage placeholder (the field-security
 * section of lib/governance-store.ts) with a real, tenant-scoped, audited,
 * DB-backed model — the same upgrade SPEC 69 made for classification.
 *
 * A policy pins a `module / entity / field` to a MASK / HIDE / READ-ONLY effect
 * for a defined audience (everyone, a role and below, a department, a legal
 * entity, or a permission group). The pure decision + masking live in
 * lib/field-security-model.ts; this module persists the policies, audits every
 * mutation, and exposes the enforcement chokepoint every read/export/report
 * surface calls so a masked field looks identical wherever data leaves the
 * system.
 *
 * Self-heals its schema at runtime (same pattern as lib/data-classification.ts)
 * so existing databases converge without a manual migration step.
 */
import { query } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { resolveRoleContext } from "@/lib/platform-roles"
import { effectiveTenantId } from "@/lib/role-model"
import {
  type FieldEffect,
  type FieldPolicyRule,
  type FieldScopeType,
  type FieldSecurityActor,
  type SensitiveCategory,
  applyFieldSecurityToRow,
  resolveFieldEffects,
  toFieldEffect,
  toFieldScopeType,
  toSensitiveCategory,
} from "@/lib/field-security-model"

export type FieldSecurityPolicy = {
  id: number
  tenantId: number | null
  module: string
  entity: string
  field: string
  category: SensitiveCategory
  scopeType: FieldScopeType
  scopeValue: string
  effect: FieldEffect
  enabled: boolean
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

type PolicyRow = {
  id: number
  tenant_id: number | null
  module: string
  entity: string
  field: string
  category: string
  scope_type: string
  scope_value: string
  effect: string
  enabled: number
  created_by: number | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`field_security_policies\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`module\` VARCHAR(96) NOT NULL,
      \`entity\` VARCHAR(96) NOT NULL,
      \`field\` VARCHAR(190) NOT NULL,
      \`category\` VARCHAR(32) NOT NULL DEFAULT 'generic',
      \`scope_type\` VARCHAR(32) NOT NULL DEFAULT 'everyone',
      \`scope_value\` VARCHAR(190) NOT NULL DEFAULT '',
      \`effect\` VARCHAR(24) NOT NULL DEFAULT 'masked',
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_field_policy\` (\`tenant_id\`, \`module\`, \`entity\`, \`field\`, \`scope_type\`, \`scope_value\`),
      KEY \`idx_field_policy_tenant\` (\`tenant_id\`),
      KEY \`idx_field_policy_lookup\` (\`tenant_id\`, \`module\`, \`entity\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
}

function ensureTable(): Promise<void> {
  if (!ensured)
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  return ensured
}

function toPublic(row: PolicyRow): FieldSecurityPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    module: row.module,
    entity: row.entity,
    field: row.field,
    category: toSensitiveCategory(row.category),
    scopeType: toFieldScopeType(row.scope_type),
    scopeValue: row.scope_value ?? "",
    effect: toFieldEffect(row.effect),
    enabled: Boolean(row.enabled),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listFieldSecurityPolicies(tenantId: number | null): Promise<FieldSecurityPolicy[]> {
  await ensureTable()
  const rows = await query<PolicyRow[]>(
    `SELECT p.*, u.name AS created_by_name
       FROM field_security_policies p
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.tenant_id = ? OR p.tenant_id IS NULL
      ORDER BY p.module, p.entity, p.field, p.scope_type, p.scope_value`,
    [tenantId],
  )
  return rows.map(toPublic)
}

export type FieldSecurityInput = {
  module: string
  entity: string
  field: string
  category: SensitiveCategory
  scopeType: FieldScopeType
  scopeValue: string
  effect: FieldEffect
  enabled: boolean
}

function validate(input: FieldSecurityInput): FieldSecurityInput {
  const module = input.module?.trim()
  const entity = input.entity?.trim()
  const field = input.field?.trim()
  if (!module) throw new Error("Module is required")
  if (!entity) throw new Error("Entity is required")
  if (!field) throw new Error("Field is required")
  const scopeType = toFieldScopeType(input.scopeType)
  const scopeValue = scopeType === "everyone" ? "" : input.scopeValue?.trim()
  if (scopeType !== "everyone" && !scopeValue) {
    throw new Error("A scope value is required unless the scope is Everyone")
  }
  return {
    module: module.slice(0, 96),
    entity: entity.slice(0, 96),
    field: field.slice(0, 190),
    category: toSensitiveCategory(input.category),
    scopeType,
    scopeValue: (scopeValue ?? "").slice(0, 190),
    effect: toFieldEffect(input.effect),
    enabled: input.enabled !== false,
  }
}

function actorContext(actor: { userId: number; name?: string; email?: string; role?: string }, tenantId: number | null) {
  return {
    tenantId,
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
  }
}

export async function createFieldSecurityPolicy(
  tenantId: number | null,
  input: FieldSecurityInput,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<FieldSecurityPolicy> {
  await ensureTable()
  const v = validate(input)

  const existing = await query<{ id: number }[]>(
    `SELECT id FROM field_security_policies
      WHERE (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))
        AND module = ? AND entity = ? AND field = ? AND scope_type = ? AND scope_value = ? LIMIT 1`,
    [tenantId, tenantId, v.module, v.entity, v.field, v.scopeType, v.scopeValue],
  )
  if (existing.length > 0) {
    throw new Error("A policy for this field and scope already exists")
  }

  const res = await query<{ insertId: number }>(
    `INSERT INTO field_security_policies
       (tenant_id, module, entity, field, category, scope_type, scope_value, effect, enabled, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, v.module, v.entity, v.field, v.category, v.scopeType, v.scopeValue, v.effect, v.enabled ? 1 : 0, actor.userId],
  )
  const id = (res as any).insertId as number
  await recordAuditLog({
    action: "field_security.create",
    entityType: "field_security_policy",
    entityId: id,
    entityLabel: `${v.module} / ${v.entity} / ${v.field}`,
    after: { ...v },
    context: actorContext(actor, tenantId),
  })
  const rows = await query<PolicyRow[]>(
    `SELECT p.*, u.name AS created_by_name FROM field_security_policies p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`,
    [id],
  )
  return toPublic(rows[0])
}

export async function updateFieldSecurityPolicy(
  tenantId: number | null,
  id: number,
  input: FieldSecurityInput,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<FieldSecurityPolicy | null> {
  await ensureTable()
  const v = validate(input)
  const current = await query<PolicyRow[]>(
    `SELECT * FROM field_security_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [id, tenantId],
  )
  if (current.length === 0) return null
  const before = toPublic(current[0])

  await query(
    `UPDATE field_security_policies
        SET module = ?, entity = ?, field = ?, category = ?, scope_type = ?, scope_value = ?, effect = ?, enabled = ?
      WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
    [v.module, v.entity, v.field, v.category, v.scopeType, v.scopeValue, v.effect, v.enabled ? 1 : 0, id, tenantId],
  )
  await recordAuditLog({
    action: "field_security.update",
    entityType: "field_security_policy",
    entityId: id,
    entityLabel: `${v.module} / ${v.entity} / ${v.field}`,
    before: {
      module: before.module,
      entity: before.entity,
      field: before.field,
      category: before.category,
      scopeType: before.scopeType,
      scopeValue: before.scopeValue,
      effect: before.effect,
      enabled: before.enabled,
    },
    after: { ...v },
    context: actorContext(actor, tenantId),
  })
  const rows = await query<PolicyRow[]>(
    `SELECT p.*, u.name AS created_by_name FROM field_security_policies p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`,
    [id],
  )
  return toPublic(rows[0])
}

export async function deleteFieldSecurityPolicy(
  tenantId: number | null,
  id: number,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<boolean> {
  await ensureTable()
  const current = await query<PolicyRow[]>(
    `SELECT * FROM field_security_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [id, tenantId],
  )
  if (current.length === 0) return false
  const before = toPublic(current[0])
  await query(`DELETE FROM field_security_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [id, tenantId])
  await recordAuditLog({
    action: "field_security.delete",
    entityType: "field_security_policy",
    entityId: id,
    entityLabel: `${before.module} / ${before.entity} / ${before.field}`,
    before: {
      module: before.module,
      entity: before.entity,
      field: before.field,
      category: before.category,
      scopeType: before.scopeType,
      scopeValue: before.scopeValue,
      effect: before.effect,
    },
    context: actorContext(actor, tenantId),
  })
  return true
}

// ---------------------------------------------------------------------------
// Enforcement — the chokepoint every read / export / report surface calls.
// ---------------------------------------------------------------------------

/** The enabled rules for one entity, as the pure model's FieldPolicyRule shape. */
export async function fieldPolicyRulesFor(
  tenantId: number | null,
  module: string,
  entity: string,
): Promise<FieldPolicyRule[]> {
  await ensureTable()
  const rows = await query<PolicyRow[]>(
    `SELECT * FROM field_security_policies
      WHERE (tenant_id = ? OR tenant_id IS NULL) AND module = ? AND entity = ? AND enabled = 1`,
    [tenantId, module, entity],
  )
  return rows.map((r) => ({
    field: r.field,
    category: toSensitiveCategory(r.category),
    scopeType: toFieldScopeType(r.scope_type),
    scopeValue: r.scope_value ?? "",
    effect: toFieldEffect(r.effect),
    enabled: Boolean(r.enabled),
  }))
}

/**
 * Build the actor a policy is matched against from a verified session. The
 * tenant role is resolved from the DB source of truth (never trusted from the
 * token); optional attribute scopes (department / legal entity / permission
 * groups) are passed by the caller when it can resolve them.
 */
export async function fieldSecurityActorFromSession(
  session: { userId: number; impersonatedTenantId?: number | null },
  extra?: Omit<FieldSecurityActor, "role">,
): Promise<FieldSecurityActor | null> {
  const ctx = await resolveRoleContext({ userId: session.userId, impersonatedTenantId: session.impersonatedTenantId })
  if (!ctx) return null
  return { role: ctx.tenantRole, ...extra }
}

/**
 * Apply field-level security to a set of records for a given actor. Masks,
 * hides, or leaves each configured field per the resolved effect. Returns the
 * sanitized rows plus the distinct effects applied (for a UI notice / audit).
 *
 * Fail-open by design: if policy lookup fails (e.g. transient DB error before
 * the table self-heals) the original rows are returned and the error is logged
 * loudly rather than breaking the endpoint. Policies only ever REMOVE
 * visibility, so a lookup failure never grants access beyond the baseline the
 * caller already authorized — it just skips the extra restriction. The
 * chokepoint is still the single place to tighten this to fail-closed if a
 * deployment requires it.
 */
export async function enforceFieldSecurity<T extends Record<string, unknown>>(
  rows: T[],
  params: { tenantId: number | null; module: string; entity: string; actor: FieldSecurityActor },
): Promise<{ rows: Partial<T>[]; applied: { field: string; effect: FieldEffect }[] }> {
  if (rows.length === 0) return { rows: rows as Partial<T>[], applied: [] }
  try {
    const rules = await fieldPolicyRulesFor(params.tenantId, params.module, params.entity)
    const effects = resolveFieldEffects(rules, params.actor)
    if (effects.size === 0) return { rows: rows as Partial<T>[], applied: [] }
    const appliedSet = new Map<string, FieldEffect>()
    const out = rows.map((row) => {
      const { row: sanitized, applied } = applyFieldSecurityToRow(row, effects)
      for (const a of applied) appliedSet.set(a.field, a.effect)
      return sanitized
    })
    return { rows: out, applied: [...appliedSet].map(([field, effect]) => ({ field, effect })) }
  } catch (err) {
    console.error("[field-security] enforcement skipped (policy lookup failed):", (err as Error).message)
    return { rows: rows as Partial<T>[], applied: [] }
  }
}

export { effectiveTenantId }
