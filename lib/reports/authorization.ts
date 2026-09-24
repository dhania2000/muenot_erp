import "server-only"
/**
 * SPEC 99 — Centralized Report Access Control.
 * ---------------------------------------------------------------------------
 * ONE authorization chokepoint every report surface (interactive run, export,
 * scheduled delivery) flows through, so a report can never expose a row or a
 * field the acting user is not entitled to — regardless of which surface asks.
 *
 * It composes the SEVEN dimensions the spec requires, each mapped to the
 * platform's existing, individually-tested enforcement primitive:
 *
 *   1. Tenant              — the query compiler ALWAYS emits `tenant_id = ?`
 *                            (or refuses); this module never widens that.
 *   2. Entity              — data-scope `entity` grant → row predicate over the
 *                            source's legal-entity column(s).
 *   3. Department          — field-security `department`-scoped policies matched
 *                            against the actor's resolved department.
 *   4. User                — data-scope `self` / `team` grant → row predicate
 *                            over the source's owner column(s).
 *   5. Role                — data-classification clearance matrix (role → the
 *                            levels it may read) redacts under-cleared fields.
 *   6. Data classification — per field sensitivity level, enforced by (5).
 *   7. Field-level security— named MASK / HIDE / READ-ONLY policies for a role,
 *                            department, legal entity or permission group.
 *
 * Row visibility (2 + 4, plus team/branch) is expressed as a SQL predicate the
 * compiler ANDs into the query, and FAILS CLOSED (`1=0`) when a relational
 * scope's column or assignment is unavailable — a misconfiguration hides rows
 * rather than leaking them. Field protection (3 + 5 + 6 + 7) is applied to the
 * returned rows. Both layers only ever REMOVE access, so an unconfigured tenant
 * keeps its current behaviour (non-breaking by construction).
 */
import { query, tableColumns } from "@/lib/db"
import { reportScopeDomain, type ReportSource } from "@/lib/reports/catalog"
import { buildDataScopeSql, type DataScopeSql } from "@/lib/data-scope-model"
import { getUserDomainScope, resolveDataScopeContext } from "@/lib/data-scope-store"
import { classifiedFieldsFor, enforceExportClassification, getClearanceMatrix } from "@/lib/data-classification"
import { enforceFieldSecurity } from "@/lib/field-security"
import type { FieldSecurityActor } from "@/lib/field-security-model"
import type { TenantRole } from "@/lib/role-model"

/**
 * The resolved facts a report is authorized against. `userId` / `tenantId` /
 * `role` always come from the verified session guard; the attribute scopes are
 * best-effort — an attribute we cannot resolve simply does not match a policy
 * (documented limitation), it never widens access.
 */
export type ReportActor = {
  userId: number
  tenantId: number | null
  role: TenantRole
  department?: string | null
  legalEntityId?: string | number | null
  permissionGroups?: string[]
}

// Candidate columns on hr_employees that carry the acting user's attributes.
const ACTOR_DEPARTMENT_COLUMNS = ["department", "department_name", "dept"]
const ACTOR_ENTITY_COLUMNS = ["legal_entity_id", "entity_id", "legal_entity", "entity"]

/**
 * Resolve the acting user's attribute scopes (department / legal entity) from
 * the HR record linked to their user id. Best-effort and cached at the column
 * level by `tableColumns`; any failure yields an actor with unknown attributes
 * (fail-open only for the OPTIONAL attributes — the mandatory role still gates).
 */
export async function resolveReportActor(base: {
  userId: number
  tenantId: number | null
  role: TenantRole
  permissionGroups?: string[]
}): Promise<ReportActor> {
  let department: string | null = null
  let legalEntityId: string | number | null = null

  if (base.userId > 0) {
    try {
      const cols = await tableColumns("hr_employees").catch(() => new Set<string>())
      if (cols.has("user_id")) {
        const deptCol = ACTOR_DEPARTMENT_COLUMNS.find((c) => cols.has(c))
        const entCol = ACTOR_ENTITY_COLUMNS.find((c) => cols.has(c))
        if (deptCol || entCol) {
          const selects = [
            deptCol ? `\`${deptCol}\` AS department` : null,
            entCol ? `\`${entCol}\` AS legal_entity` : null,
          ]
            .filter(Boolean)
            .join(", ")
          const rows = await query<{ department?: string | null; legal_entity?: string | number | null }[]>(
            `SELECT ${selects} FROM \`hr_employees\` WHERE \`user_id\` = ? LIMIT 1`,
            [base.userId],
          )
          const row = rows[0]
          if (row) {
            if (deptCol && row.department != null && String(row.department).trim() !== "") {
              department = String(row.department)
            }
            if (entCol && row.legal_entity != null && String(row.legal_entity).trim() !== "") {
              legalEntityId = row.legal_entity
            }
          }
        }
      }
    } catch {
      // best-effort — leave attributes unknown.
    }
  }

  return {
    userId: base.userId,
    tenantId: base.tenantId,
    role: base.role,
    department,
    legalEntityId,
    permissionGroups: base.permissionGroups ?? [],
  }
}

/**
 * Build the ROW-visibility predicate (Tenant is handled by the compiler; this
 * adds User / Team / Entity / Branch) for a source and actor, resolved against
 * the source's LIVE columns. Returns:
 *   - `null`           → no restriction (no linked domain, `all` grant, or no
 *                        tenant in context) — the caller appends nothing.
 *   - `{ sql: "1=0" }` → deny everything (`none`, or a relational scope whose
 *                        column/assignment is unavailable — fail CLOSED).
 *   - a real predicate → e.g. `(user_id = ?)` / `entity IN (?)`.
 */
export async function buildReportScope(
  source: ReportSource,
  actor: ReportActor,
  existing: Set<string>,
): Promise<DataScopeSql | null> {
  if (actor.tenantId == null || actor.userId <= 0) return null

  const domain = reportScopeDomain(source)
  if (!domain) return null

  const kind = await getUserDomainScope(actor.tenantId, actor.userId, domain.key)
  if (kind == null || kind === "all") return null

  const ctx = await resolveDataScopeContext(actor.tenantId, actor.userId)
  // No alias: the report query selects `FROM \`table\`` with bare column refs.
  return buildDataScopeSql(kind, domain, ctx, existing)
}

export type ReportSecurityResult<T> = {
  rows: Partial<T>[]
  /** Fields removed by data-classification clearance (Role + Classification). */
  redactedFields: string[]
  /** Fields masked or hidden by field-level security (Department / Role / etc.). */
  maskedFields: string[]
}

/**
 * Apply FIELD-level protection to already-row-scoped results: first the
 * data-classification clearance redaction (Role × Classification), then
 * field-level security masking/hiding (Role / Department / Legal entity /
 * Permission group). Aggregated outputs use derived aliases that do not map to
 * classified field names, so they pass through untouched — exactly as before.
 */
export async function enforceReportSecurity<T extends Record<string, unknown>>(
  rows: T[],
  params: { source: ReportSource; actor: ReportActor; isAggregated: boolean },
): Promise<ReportSecurityResult<T>> {
  if (params.isAggregated || rows.length === 0) {
    return { rows: rows as Partial<T>[], redactedFields: [], maskedFields: [] }
  }
  const { source, actor } = params

  // (5)+(6) Role × Data classification — drop fields the role may not read.
  const [matrix, fields] = await Promise.all([
    getClearanceMatrix(),
    classifiedFieldsFor(actor.tenantId, source.module, source.entity),
  ])
  const cleared = enforceExportClassification(rows, fields, actor.role, matrix)

  // (3)+(7) Field-level security — mask/hide named sensitive fields.
  const fsActor: FieldSecurityActor = {
    role: actor.role,
    department: actor.department ?? null,
    legalEntityId: actor.legalEntityId ?? null,
    permissionGroups: actor.permissionGroups ?? [],
  }
  const secured = await enforceFieldSecurity(cleared.rows as Record<string, unknown>[], {
    tenantId: actor.tenantId,
    module: source.module,
    entity: source.entity,
    actor: fsActor,
  })

  return {
    rows: secured.rows as Partial<T>[],
    redactedFields: cleared.redacted,
    maskedFields: secured.applied.map((a) => a.field),
  }
}
