import "server-only"
import { query } from "./db"
import { requireCurrentTenantId } from "./tenant-context"
import {
  type ApprovalRuleDef,
  type ApprovalLevelDef,
  type ApproverTarget,
  type ApprovalContext,
  type LevelMode,
  type RequestStepState,
  type Delegation,
  type PlannedStep,
  selectRule,
  buildChain,
  evaluateRequest,
  resolveDelegate,
  computeEscalations,
} from "./approval-authority-core"
import { violatesSegregation, SEGREGATION_MESSAGE } from "./maker-checker-core"

// =============================================================================
// Approval Authority: DB persistence + orchestration.
// -----------------------------------------------------------------------------
// This is the stateful half of the engine. It owns the schema (self-healing,
// tenant-scoped like the rest of the app) and turns the pure decisions made in
// approval-authority-core.ts into rows: configurable rules with multi-level
// chains, live approval requests raised by business modules, per-step state,
// delegations, and an append-only action audit trail.
//
// Every read/write is scoped by the verified session tenant (never client
// input), matching lib/role-store.ts and lib/legal-entities.ts.
// =============================================================================

let schemaEnsured: Promise<void> | null = null

export function ensureApprovalSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = runEnsure().catch((err) => {
      schemaEnsured = null
      throw err
    })
  }
  return schemaEnsured
}

async function runEnsure(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS approval_rules (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      module_key VARCHAR(80) NOT NULL DEFAULT '*',
      active TINYINT(1) NOT NULL DEFAULT 1,
      priority INT NOT NULL DEFAULT 0,
      entity_id INT UNSIGNED DEFAULT NULL,
      department VARCHAR(150) DEFAULT NULL,
      applies_role VARCHAR(150) DEFAULT NULL,
      min_amount DECIMAL(18,2) DEFAULT NULL,
      max_amount DECIMAL(18,2) DEFAULT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ar_tenant_module (tenant_id, module_key),
      KEY idx_ar_tenant_active (tenant_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_rule_levels (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      rule_id INT UNSIGNED NOT NULL,
      level_no INT NOT NULL,
      name VARCHAR(160) DEFAULT NULL,
      mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
      quorum INT DEFAULT NULL,
      escalate_after_hours INT DEFAULT NULL,
      escalate_to_kind ENUM('user','role','department','dynamic') DEFAULT NULL,
      escalate_to_value VARCHAR(190) DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_rule_level (rule_id, level_no),
      KEY idx_arl_rule (rule_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_rule_level_approvers (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      level_id INT UNSIGNED NOT NULL,
      kind ENUM('user','role','department','dynamic') NOT NULL,
      value VARCHAR(190) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_arla_level (level_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_requests (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      entity_type VARCHAR(80) DEFAULT NULL,
      entity_pk INT UNSIGNED DEFAULT NULL,
      entity_ref VARCHAR(190) DEFAULT NULL,
      title VARCHAR(255) DEFAULT NULL,
      amount DECIMAL(18,2) DEFAULT NULL,
      department VARCHAR(150) DEFAULT NULL,
      requester_role VARCHAR(150) DEFAULT NULL,
      legal_entity_id INT UNSIGNED DEFAULT NULL,
      rule_id INT UNSIGNED DEFAULT NULL,
      status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
      current_level INT DEFAULT NULL,
      requested_by INT UNSIGNED DEFAULT NULL,
      requested_by_name VARCHAR(190) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      decided_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_areq_tenant_status (tenant_id, status),
      KEY idx_areq_entity (tenant_id, entity_type, entity_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_request_steps (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      request_id INT UNSIGNED NOT NULL,
      level_no INT NOT NULL,
      level_name VARCHAR(160) DEFAULT NULL,
      mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
      quorum INT DEFAULT NULL,
      target_kind ENUM('user','role','department','dynamic') NOT NULL,
      target_value VARCHAR(190) NOT NULL,
      approver_user_id INT UNSIGNED DEFAULT NULL,
      decision ENUM('pending','approved','rejected','skipped','delegated') NOT NULL DEFAULT 'pending',
      acted_by INT UNSIGNED DEFAULT NULL,
      acted_at TIMESTAMP NULL DEFAULT NULL,
      comment VARCHAR(500) DEFAULT NULL,
      activated_at TIMESTAMP NULL DEFAULT NULL,
      is_escalation TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_ars_request (request_id),
      KEY idx_ars_approver (approver_user_id, decision)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_step_actions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      request_id INT UNSIGNED NOT NULL,
      step_id INT UNSIGNED DEFAULT NULL,
      action ENUM('raise','approve','reject','delegate','escalate','auto_approve','cancel') NOT NULL,
      actor_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(190) DEFAULT NULL,
      from_user_id INT UNSIGNED DEFAULT NULL,
      to_user_id INT UNSIGNED DEFAULT NULL,
      comment VARCHAR(500) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_asa_request (request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS approval_delegations (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      from_user_id INT UNSIGNED NOT NULL,
      to_user_id INT UNSIGNED NOT NULL,
      reason VARCHAR(300) DEFAULT NULL,
      starts_at TIMESTAMP NULL DEFAULT NULL,
      ends_at TIMESTAMP NULL DEFAULT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_adel_tenant (tenant_id),
      KEY idx_adel_from (tenant_id, from_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
}

// ---------------------------------------------------------------------------
// Types exposed to routes / UI
// ---------------------------------------------------------------------------

export type ApprovalRuleRecord = ApprovalRuleDef & {
  createdAt: string
  updatedAt: string
}

export type ApprovalRequestRecord = {
  id: number
  moduleKey: string
  entityType: string | null
  entityPk: number | null
  entityRef: string | null
  title: string | null
  amount: number | null
  department: string | null
  requesterRole: string | null
  legalEntityId: number | null
  ruleId: number | null
  status: "pending" | "approved" | "rejected" | "cancelled"
  currentLevel: number | null
  requestedBy: number | null
  requestedByName: string | null
  createdAt: string
  updatedAt: string
  decidedAt: string | null
}

export type ApprovalStepRecord = {
  id: number
  requestId: number
  levelNo: number
  levelName: string | null
  mode: LevelMode
  quorum: number | null
  targetKind: ApproverTarget["kind"]
  targetValue: string
  approverUserId: number | null
  approverName: string | null
  decision: RequestStepState["decision"]
  actedBy: number | null
  actedAt: string | null
  comment: string | null
  activatedAt: string | null
  isEscalation: boolean
}

// ---------------------------------------------------------------------------
// Rule reads
// ---------------------------------------------------------------------------

/** Load every rule for the tenant, hydrated into the pure-core shape. */
export async function listRules(): Promise<ApprovalRuleRecord[]> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const rules = await query<any[]>(
    `SELECT * FROM approval_rules WHERE tenant_id = ? ORDER BY priority DESC, id ASC`,
    [tenantId],
  )
  if (rules.length === 0) return []
  const ruleIds = rules.map((r) => r.id)
  const levels = await query<any[]>(
    `SELECT * FROM approval_rule_levels WHERE rule_id IN (${ruleIds.map(() => "?").join(",")}) ORDER BY level_no ASC`,
    ruleIds,
  )
  const levelIds = levels.map((l) => l.id)
  const approvers = levelIds.length
    ? await query<any[]>(
        `SELECT * FROM approval_rule_level_approvers WHERE level_id IN (${levelIds.map(() => "?").join(",")})`,
        levelIds,
      )
    : []

  const approversByLevel = new Map<number, ApproverTarget[]>()
  for (const a of approvers) {
    const list = approversByLevel.get(a.level_id) ?? []
    list.push({ kind: a.kind, value: String(a.value) })
    approversByLevel.set(a.level_id, list)
  }
  const levelsByRule = new Map<number, ApprovalLevelDef[]>()
  for (const l of levels) {
    const list = levelsByRule.get(l.rule_id) ?? []
    list.push({
      levelNo: Number(l.level_no),
      name: l.name ?? null,
      mode: l.mode as LevelMode,
      quorum: l.quorum != null ? Number(l.quorum) : null,
      approvers: approversByLevel.get(l.id) ?? [],
      escalateAfterHours: l.escalate_after_hours != null ? Number(l.escalate_after_hours) : null,
      escalateTo:
        l.escalate_to_kind && l.escalate_to_value
          ? { kind: l.escalate_to_kind, value: String(l.escalate_to_value) }
          : null,
    })
    levelsByRule.set(l.rule_id, list)
  }

  return rules.map((r) => hydrateRule(r, levelsByRule.get(r.id) ?? []))
}

export async function getRule(ruleId: number): Promise<ApprovalRuleRecord | null> {
  const all = await listRules()
  return all.find((r) => r.id === ruleId) ?? null
}

function hydrateRule(r: any, levels: ApprovalLevelDef[]): ApprovalRuleRecord {
  return {
    id: Number(r.id),
    name: r.name,
    moduleKey: r.module_key,
    active: Boolean(r.active),
    priority: Number(r.priority) || 0,
    conditions: {
      entityId: r.entity_id != null ? Number(r.entity_id) : null,
      department: r.department ?? null,
      role: r.applies_role ?? null,
      minAmount: r.min_amount != null ? Number(r.min_amount) : null,
      maxAmount: r.max_amount != null ? Number(r.max_amount) : null,
    },
    levels,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Rule writes
// ---------------------------------------------------------------------------

export type RuleInput = {
  name: string
  moduleKey: string
  active?: boolean
  priority?: number
  conditions?: {
    entityId?: number | null
    department?: string | null
    role?: string | null
    minAmount?: number | null
    maxAmount?: number | null
  }
  levels: Array<{
    levelNo: number
    name?: string | null
    mode: LevelMode
    quorum?: number | null
    approvers: ApproverTarget[]
    escalateAfterHours?: number | null
    escalateTo?: ApproverTarget | null
  }>
}

export async function createRule(input: RuleInput, createdBy: number): Promise<number> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const c = input.conditions ?? {}
  const res = await query<any>(
    `INSERT INTO approval_rules
       (tenant_id, name, module_key, active, priority, entity_id, department, applies_role, min_amount, max_amount, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      input.name.trim(),
      input.moduleKey.trim() || "*",
      input.active === false ? 0 : 1,
      Number.isFinite(input.priority) ? input.priority : 0,
      c.entityId ?? null,
      c.department?.trim() || null,
      c.role?.trim() || null,
      c.minAmount ?? null,
      c.maxAmount ?? null,
      createdBy,
    ],
  )
  const ruleId = Number(res.insertId)
  await replaceLevels(ruleId, input.levels)
  return ruleId
}

export async function updateRule(ruleId: number, input: RuleInput): Promise<boolean> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM approval_rules WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, ruleId],
  )
  if (owned.length === 0) return false
  const c = input.conditions ?? {}
  await query(
    `UPDATE approval_rules SET name=?, module_key=?, active=?, priority=?, entity_id=?, department=?, applies_role=?, min_amount=?, max_amount=?
      WHERE tenant_id = ? AND id = ?`,
    [
      input.name.trim(),
      input.moduleKey.trim() || "*",
      input.active === false ? 0 : 1,
      Number.isFinite(input.priority) ? input.priority : 0,
      c.entityId ?? null,
      c.department?.trim() || null,
      c.role?.trim() || null,
      c.minAmount ?? null,
      c.maxAmount ?? null,
      tenantId,
      ruleId,
    ],
  )
  await replaceLevels(ruleId, input.levels)
  return true
}

async function replaceLevels(ruleId: number, levels: RuleInput["levels"]): Promise<void> {
  const existing = await query<{ id: number }[]>(`SELECT id FROM approval_rule_levels WHERE rule_id = ?`, [ruleId])
  if (existing.length) {
    await query(
      `DELETE FROM approval_rule_level_approvers WHERE level_id IN (${existing.map(() => "?").join(",")})`,
      existing.map((e) => e.id),
    )
    await query(`DELETE FROM approval_rule_levels WHERE rule_id = ?`, [ruleId])
  }
  for (const level of levels) {
    const res = await query<any>(
      `INSERT INTO approval_rule_levels
         (rule_id, level_no, name, mode, quorum, escalate_after_hours, escalate_to_kind, escalate_to_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        ruleId,
        level.levelNo,
        level.name?.trim() || null,
        level.mode,
        level.mode === "quorum" ? Math.max(1, level.quorum ?? 1) : null,
        level.escalateAfterHours ?? null,
        level.escalateTo?.kind ?? null,
        level.escalateTo?.value ?? null,
      ],
    )
    const levelId = Number(res.insertId)
    const approvers = (level.approvers ?? []).filter((a) => a && a.kind && a.value)
    if (approvers.length) {
      await query(
        `INSERT INTO approval_rule_level_approvers (level_id, kind, value) VALUES ${approvers
          .map(() => "(?,?,?)")
          .join(",")}`,
        approvers.flatMap((a) => [levelId, a.kind, String(a.value)]),
      )
    }
  }
}

export async function deleteRule(ruleId: number): Promise<void> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM approval_rules WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, ruleId],
  )
  if (owned.length === 0) return
  const levels = await query<{ id: number }[]>(`SELECT id FROM approval_rule_levels WHERE rule_id = ?`, [ruleId])
  if (levels.length) {
    await query(
      `DELETE FROM approval_rule_level_approvers WHERE level_id IN (${levels.map(() => "?").join(",")})`,
      levels.map((l) => l.id),
    )
  }
  await query(`DELETE FROM approval_rule_levels WHERE rule_id = ?`, [ruleId])
  await query(`DELETE FROM approval_rules WHERE tenant_id = ? AND id = ?`, [tenantId, ruleId])
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------

export type DelegationRecord = {
  id: number
  fromUserId: number
  fromName: string | null
  toUserId: number
  toName: string | null
  reason: string | null
  startsAt: string | null
  endsAt: string | null
  active: boolean
  createdAt: string
}

export async function listDelegations(): Promise<DelegationRecord[]> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT d.*, uf.name AS from_name, ut.name AS to_name
       FROM approval_delegations d
       LEFT JOIN users uf ON uf.id = d.from_user_id
       LEFT JOIN users ut ON ut.id = d.to_user_id
      WHERE d.tenant_id = ? ORDER BY d.created_at DESC`,
    [tenantId],
  )
  return rows.map((d) => ({
    id: Number(d.id),
    fromUserId: Number(d.from_user_id),
    fromName: d.from_name ?? null,
    toUserId: Number(d.to_user_id),
    toName: d.to_name ?? null,
    reason: d.reason ?? null,
    startsAt: d.starts_at ? new Date(d.starts_at).toISOString() : null,
    endsAt: d.ends_at ? new Date(d.ends_at).toISOString() : null,
    active: Boolean(d.active),
    createdAt: d.created_at,
  }))
}

export async function createDelegation(
  input: { fromUserId: number; toUserId: number; reason?: string | null; startsAt?: string | null; endsAt?: string | null },
  createdBy: number,
): Promise<number> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const res = await query<any>(
    `INSERT INTO approval_delegations (tenant_id, from_user_id, to_user_id, reason, starts_at, ends_at, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      tenantId,
      input.fromUserId,
      input.toUserId,
      input.reason?.trim() || null,
      input.startsAt ? new Date(input.startsAt) : null,
      input.endsAt ? new Date(input.endsAt) : null,
      createdBy,
    ],
  )
  return Number(res.insertId)
}

export async function setDelegationActive(id: number, active: boolean): Promise<void> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  await query(`UPDATE approval_delegations SET active = ? WHERE tenant_id = ? AND id = ?`, [active ? 1 : 0, tenantId, id])
}

export async function deleteDelegation(id: number): Promise<void> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  await query(`DELETE FROM approval_delegations WHERE tenant_id = ? AND id = ?`, [tenantId, id])
}

async function loadActiveDelegations(tenantId: number): Promise<Delegation[]> {
  const rows = await query<any[]>(
    `SELECT from_user_id, to_user_id, starts_at, ends_at, active FROM approval_delegations WHERE tenant_id = ?`,
    [tenantId],
  )
  return rows.map((d) => ({
    fromUserId: Number(d.from_user_id),
    toUserId: Number(d.to_user_id),
    startsAt: d.starts_at ? new Date(d.starts_at).toISOString() : null,
    endsAt: d.ends_at ? new Date(d.ends_at).toISOString() : null,
    active: Boolean(d.active),
  }))
}

// ---------------------------------------------------------------------------
// Approver resolution
// ---------------------------------------------------------------------------

/**
 * Turn a level's approver targets into concrete step rows. `user` targets map
 * to one step for that account; `role` targets fan out to one step per member
 * of the custom role; `department` / `dynamic` targets are kept as a single
 * unresolved (admin-claimable) step so the chain never silently auto-passes an
 * empty level. Delegation is applied so a step lands on the delegate if the
 * named approver has delegated away their authority.
 */
async function resolveTargetToSteps(
  target: ApproverTarget,
  delegations: Delegation[],
): Promise<Array<{ approverUserId: number | null }>> {
  if (target.kind === "user") {
    const uid = Number(target.value)
    if (!Number.isFinite(uid)) return [{ approverUserId: null }]
    return [{ approverUserId: resolveDelegate(uid, delegations) }]
  }
  if (target.kind === "role") {
    const roleId = Number(target.value)
    if (!Number.isFinite(roleId)) return [{ approverUserId: null }]
    const members = await query<{ user_id: number }[]>(
      `SELECT ucr.user_id FROM user_custom_roles ucr WHERE ucr.role_id = ?`,
      [roleId],
    )
    if (members.length === 0) return [{ approverUserId: null }]
    const seen = new Set<number>()
    const steps: Array<{ approverUserId: number | null }> = []
    for (const m of members) {
      const uid = resolveDelegate(Number(m.user_id), delegations)
      if (seen.has(uid)) continue
      seen.add(uid)
      steps.push({ approverUserId: uid })
    }
    return steps
  }
  // department / dynamic -> claimable placeholder (resolved at act time by admin)
  return [{ approverUserId: null }]
}

// ---------------------------------------------------------------------------
// Raising a request
// ---------------------------------------------------------------------------

export type RaiseInput = {
  moduleKey: string
  entityType?: string | null
  entityPk?: number | null
  entityRef?: string | null
  title?: string | null
  amount?: number | null
  department?: string | null
  requesterRole?: string | null
  legalEntityId?: number | null
  requestedBy: number
  requestedByName?: string | null
}

export type RaiseResult = {
  requestId: number
  status: ApprovalRequestRecord["status"]
  ruleId: number | null
  autoApproved: boolean
  currentLevel: number | null
}

/**
 * Entry point business modules call when something needs approval. Selects the
 * governing rule for the context, builds and persists the approval chain, and
 * activates the first level. When no rule matches, the item is recorded as
 * auto-approved (no configured authority ⇒ nothing to hold it up) so callers
 * get a uniform result they can gate on.
 */
export async function raiseApprovalRequest(input: RaiseInput): Promise<RaiseResult> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()

  const ctx: ApprovalContext = {
    moduleKey: input.moduleKey,
    amount: input.amount ?? null,
    department: input.department ?? null,
    role: input.requesterRole ?? null,
    entityId: input.legalEntityId ?? null,
  }
  const rules = await listRules()
  const rule = selectRule(rules, ctx)

  const status: ApprovalRequestRecord["status"] = rule ? "pending" : "approved"
  const plannedChain: PlannedStep[] = rule ? buildChain(rule) : []
  const firstLevel = plannedChain.length ? plannedChain[0].levelNo : null

  const res = await query<any>(
    `INSERT INTO approval_requests
       (tenant_id, module_key, entity_type, entity_pk, entity_ref, title, amount, department, requester_role, legal_entity_id, rule_id, status, current_level, requested_by, requested_by_name, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      input.moduleKey,
      input.entityType ?? null,
      input.entityPk ?? null,
      input.entityRef ?? null,
      input.title ?? null,
      input.amount ?? null,
      input.department ?? null,
      input.requesterRole ?? null,
      input.legalEntityId ?? null,
      rule?.id ?? null,
      status,
      firstLevel,
      input.requestedBy,
      input.requestedByName ?? null,
      status === "approved" ? new Date() : null,
    ],
  )
  const requestId = Number(res.insertId)

  if (!rule) {
    await logAction(requestId, null, "auto_approve", input.requestedBy, input.requestedByName ?? null, {
      comment: "No approval rule matched — auto-approved.",
    })
    return { requestId, status: "approved", ruleId: null, autoApproved: true, currentLevel: null }
  }

  const delegations = await loadActiveDelegations(tenantId)
  const now = new Date()
  for (const planned of plannedChain) {
    const resolved = await resolveTargetToSteps(planned.target, delegations)
    for (const r of resolved) {
      await query(
        `INSERT INTO approval_request_steps
           (request_id, level_no, level_name, mode, quorum, target_kind, target_value, approver_user_id, activated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          requestId,
          planned.levelNo,
          planned.levelName,
          planned.mode,
          planned.quorum,
          planned.target.kind,
          planned.target.value,
          r.approverUserId,
          planned.levelNo === firstLevel ? now : null,
        ],
      )
    }
  }
  await logAction(requestId, null, "raise", input.requestedBy, input.requestedByName ?? null, {
    comment: `Raised under rule "${rule.name}".`,
  })

  return { requestId, status: "pending", ruleId: rule.id, autoApproved: false, currentLevel: firstLevel }
}

// ---------------------------------------------------------------------------
// Reads for requests / inbox
// ---------------------------------------------------------------------------

function mapRequest(r: any): ApprovalRequestRecord {
  return {
    id: Number(r.id),
    moduleKey: r.module_key,
    entityType: r.entity_type ?? null,
    entityPk: r.entity_pk != null ? Number(r.entity_pk) : null,
    entityRef: r.entity_ref ?? null,
    title: r.title ?? null,
    amount: r.amount != null ? Number(r.amount) : null,
    department: r.department ?? null,
    requesterRole: r.requester_role ?? null,
    legalEntityId: r.legal_entity_id != null ? Number(r.legal_entity_id) : null,
    ruleId: r.rule_id != null ? Number(r.rule_id) : null,
    status: r.status,
    currentLevel: r.current_level != null ? Number(r.current_level) : null,
    requestedBy: r.requested_by != null ? Number(r.requested_by) : null,
    requestedByName: r.requested_by_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  }
}

async function loadSteps(requestId: number): Promise<ApprovalStepRecord[]> {
  const rows = await query<any[]>(
    `SELECT s.*, u.name AS approver_name
       FROM approval_request_steps s
       LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id = ? ORDER BY s.level_no ASC, s.id ASC`,
    [requestId],
  )
  return rows.map((s) => ({
    id: Number(s.id),
    requestId: Number(s.request_id),
    levelNo: Number(s.level_no),
    levelName: s.level_name ?? null,
    mode: s.mode as LevelMode,
    quorum: s.quorum != null ? Number(s.quorum) : null,
    targetKind: s.target_kind,
    targetValue: String(s.target_value),
    approverUserId: s.approver_user_id != null ? Number(s.approver_user_id) : null,
    approverName: s.approver_name ?? null,
    decision: s.decision,
    actedBy: s.acted_by != null ? Number(s.acted_by) : null,
    actedAt: s.acted_at ? new Date(s.acted_at).toISOString() : null,
    comment: s.comment ?? null,
    activatedAt: s.activated_at ? new Date(s.activated_at).toISOString() : null,
    isEscalation: Boolean(s.is_escalation),
  }))
}

export async function getRequestDetail(requestId: number): Promise<
  | { request: ApprovalRequestRecord; steps: ApprovalStepRecord[]; actions: ApprovalActionRecord[] }
  | null
> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(`SELECT * FROM approval_requests WHERE tenant_id = ? AND id = ? LIMIT 1`, [
    tenantId,
    requestId,
  ])
  if (rows.length === 0) return null
  const steps = await loadSteps(requestId)
  const actions = await loadActions(requestId)
  return { request: mapRequest(rows[0]), steps, actions }
}

export type ApprovalActionRecord = {
  id: number
  action: string
  actorId: number | null
  actorName: string | null
  fromUserId: number | null
  toUserId: number | null
  comment: string | null
  createdAt: string
}

async function loadActions(requestId: number): Promise<ApprovalActionRecord[]> {
  const rows = await query<any[]>(
    `SELECT a.*, u.name AS actor_display FROM approval_step_actions a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.request_id = ? ORDER BY a.created_at ASC, a.id ASC`,
    [requestId],
  )
  return rows.map((a) => ({
    id: Number(a.id),
    action: a.action,
    actorId: a.actor_id != null ? Number(a.actor_id) : null,
    actorName: a.actor_name || a.actor_display || null,
    fromUserId: a.from_user_id != null ? Number(a.from_user_id) : null,
    toUserId: a.to_user_id != null ? Number(a.to_user_id) : null,
    comment: a.comment ?? null,
    createdAt: a.created_at,
  }))
}

/** Requests currently awaiting the given user (directly or via delegation). */
export async function listInboxForUser(
  userId: number,
  opts: { isAdmin?: boolean } = {},
): Promise<Array<ApprovalRequestRecord & { myStepIds: number[] }>> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  await sweepEscalations(tenantId)

  const delegations = await loadActiveDelegations(tenantId)
  // Every user who delegates (transitively) to this user — their assigned steps
  // are actionable by this user too.
  const delegators = new Set<number>([userId])
  for (const d of delegations) {
    if (resolveDelegate(d.fromUserId, delegations) === userId) delegators.add(d.fromUserId)
  }
  const ids = Array.from(delegators)

  const rows = await query<any[]>(
    `SELECT DISTINCT r.*
       FROM approval_requests r
       JOIN approval_request_steps s ON s.request_id = r.id
      WHERE r.tenant_id = ? AND r.status = 'pending'
        AND s.level_no = r.current_level AND s.decision = 'pending'
        AND ( s.approver_user_id IN (${ids.map(() => "?").join(",")})
              ${opts.isAdmin ? "OR s.approver_user_id IS NULL" : ""} )
      ORDER BY r.created_at ASC`,
    [tenantId, ...ids],
  )

  const result: Array<ApprovalRequestRecord & { myStepIds: number[] }> = []
  for (const r of rows) {
    const steps = await loadSteps(Number(r.id))
    const myStepIds = steps
      .filter(
        (s) =>
          s.levelNo === Number(r.current_level) &&
          s.decision === "pending" &&
          (ids.includes(s.approverUserId ?? -1) || (opts.isAdmin && s.approverUserId == null)),
      )
      .map((s) => s.id)
    result.push({ ...mapRequest(r), myStepIds })
  }
  return result
}

export async function listRequests(filter?: {
  status?: ApprovalRequestRecord["status"]
  moduleKey?: string
}): Promise<ApprovalRequestRecord[]> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const where: string[] = ["tenant_id = ?"]
  const params: any[] = [tenantId]
  if (filter?.status) {
    where.push("status = ?")
    params.push(filter.status)
  }
  if (filter?.moduleKey) {
    where.push("module_key = ?")
    params.push(filter.moduleKey)
  }
  const rows = await query<any[]>(
    `SELECT * FROM approval_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
    params,
  )
  return rows.map(mapRequest)
}

/** The latest approval decision for a specific business record. */
export async function getEntityApprovalStatus(
  entityType: string,
  entityPk: number,
): Promise<ApprovalRequestRecord | null> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT * FROM approval_requests WHERE tenant_id = ? AND entity_type = ? AND entity_pk = ? ORDER BY id DESC LIMIT 1`,
    [tenantId, entityType, entityPk],
  )
  return rows.length ? mapRequest(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Acting on a request
// ---------------------------------------------------------------------------

export type ActInput = {
  requestId: number
  actorId: number
  actorName?: string | null
  action: "approve" | "reject" | "delegate" | "escalate" | "cancel"
  comment?: string | null
  /** For delegate: the user the step is reassigned to. */
  delegateToUserId?: number | null
}

export type ActResult =
  | { ok: true; status: ApprovalRequestRecord["status"]; currentLevel: number | null }
  | { ok: false; error: string; code: number }

/**
 * Apply an approver action and recompute the chain. Enforces that only the
 * currently-active level can be acted on, that the actor is an assigned
 * approver (or their delegate, or an admin claiming an unresolved slot), and
 * re-derives request status + the next active level via the pure core.
 */
export async function actOnApprovalRequest(input: ActInput, opts: { isAdmin?: boolean } = {}): Promise<ActResult> {
  await ensureApprovalSchema()
  const tenantId = requireCurrentTenantId()

  const rows = await query<any[]>(`SELECT * FROM approval_requests WHERE tenant_id = ? AND id = ? LIMIT 1`, [
    tenantId,
    input.requestId,
  ])
  if (rows.length === 0) return { ok: false, error: "Request not found", code: 404 }
  const request = mapRequest(rows[0])

  if (input.action === "cancel") {
    if (request.status !== "pending") return { ok: false, error: "Only pending requests can be cancelled", code: 409 }
    if (!opts.isAdmin && request.requestedBy !== input.actorId)
      return { ok: false, error: "Only the requester or an admin can cancel", code: 403 }
    await query(`UPDATE approval_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`, [
      new Date(),
      request.id,
    ])
    await logAction(request.id, null, "cancel", input.actorId, input.actorName ?? null, { comment: input.comment })
    return { ok: true, status: "cancelled", currentLevel: null }
  }

  if (request.status !== "pending") return { ok: false, error: "Request is already decided", code: 409 }

  // segregation of duties / bypass prevention. The maker of a request
  // can never act as its own checker, for anyone, admins included. Cancel is the
  // maker's own withdrawal and is handled above, so only checker actions reach
  // here. This is the single choke point every approve/reject/delegate/escalate
  // must pass through, so there is no way to self-approve a gated operation.
  if (violatesSegregation({ actorId: input.actorId, requesterId: request.requestedBy, action: input.action })) {
    return { ok: false, error: SEGREGATION_MESSAGE, code: 403 }
  }

  const steps = await loadSteps(request.id)
  const delegations = await loadActiveDelegations(tenantId)
  const activeLevel = request.currentLevel

  // Steps at the active level this actor is entitled to act on.
  const actionable = steps.filter((s) => {
    if (s.levelNo !== activeLevel || s.decision !== "pending") return false
    if (s.approverUserId == null) return Boolean(opts.isAdmin)
    if (s.approverUserId === input.actorId) return true
    if (resolveDelegate(s.approverUserId, delegations) === input.actorId) return true
    return Boolean(opts.isAdmin)
  })
  if (actionable.length === 0)
    return { ok: false, error: "You have no pending step on this request", code: 403 }

  const now = new Date()

  if (input.action === "delegate") {
    const to = input.delegateToUserId
    if (!to) return { ok: false, error: "A delegate user is required", code: 400 }
    for (const s of actionable) {
      await query(
        `UPDATE approval_request_steps SET approver_user_id = ?, decision = 'pending', activated_at = COALESCE(activated_at, ?) WHERE id = ?`,
        [to, now, s.id],
      )
      await logAction(request.id, s.id, "delegate", input.actorId, input.actorName ?? null, {
        fromUserId: s.approverUserId ?? input.actorId,
        toUserId: to,
        comment: input.comment,
      })
    }
    return { ok: true, status: "pending", currentLevel: activeLevel }
  }

  if (input.action === "escalate") {
    // Add a parallel escalation slot at the active level for each actionable
    // step, targeting the level's configured escalateTo (falls back to the
    // provided delegate user, else an admin-claimable slot).
    const target = await resolveEscalationTarget(request.ruleId, activeLevel, input.delegateToUserId ?? null, delegations)
    for (const s of actionable) {
      await query(
        `INSERT INTO approval_request_steps
           (request_id, level_no, level_name, mode, quorum, target_kind, target_value, approver_user_id, activated_at, is_escalation)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
        [request.id, s.levelNo, s.levelName, s.mode, s.quorum, target.kind, target.value, target.approverUserId, now],
      )
      await logAction(request.id, s.id, "escalate", input.actorId, input.actorName ?? null, {
        toUserId: target.approverUserId,
        comment: input.comment,
      })
    }
    return { ok: true, status: "pending", currentLevel: activeLevel }
  }

  // approve / reject
  const decision = input.action === "approve" ? "approved" : "rejected"
  const toUpdate = decision === "rejected" ? actionable.slice(0, 1) : actionable
  for (const s of toUpdate) {
    await query(
      `UPDATE approval_request_steps SET decision = ?, acted_by = ?, acted_at = ?, comment = ?, approver_user_id = COALESCE(approver_user_id, ?) WHERE id = ?`,
      [decision, input.actorId, now, input.comment ?? null, input.actorId, s.id],
    )
    await logAction(request.id, s.id, input.action, input.actorId, input.actorName ?? null, { comment: input.comment })
  }

  // Recompute from the fresh step set.
  const fresh = await loadSteps(request.id)
  const stepStates: RequestStepState[] = fresh.map((s) => ({
    levelNo: s.levelNo,
    mode: s.mode,
    quorum: s.quorum,
    decision: s.decision,
  }))
  const evalResult = evaluateRequest(stepStates)

  // Activate steps for a newly-reached level.
  if (evalResult.status === "pending" && evalResult.currentLevel != null) {
    await query(
      `UPDATE approval_request_steps SET activated_at = ? WHERE request_id = ? AND level_no = ? AND activated_at IS NULL AND decision = 'pending'`,
      [now, request.id, evalResult.currentLevel],
    )
  }

  await query(`UPDATE approval_requests SET status = ?, current_level = ?, decided_at = ? WHERE id = ?`, [
    evalResult.status,
    evalResult.currentLevel,
    evalResult.status === "pending" ? null : now,
    request.id,
  ])

  return { ok: true, status: evalResult.status, currentLevel: evalResult.currentLevel }
}

async function resolveEscalationTarget(
  ruleId: number | null,
  levelNo: number | null,
  fallbackUserId: number | null,
  delegations: Delegation[],
): Promise<{ kind: ApproverTarget["kind"]; value: string; approverUserId: number | null }> {
  if (ruleId != null && levelNo != null) {
    const rows = await query<any[]>(
      `SELECT escalate_to_kind, escalate_to_value FROM approval_rule_levels WHERE rule_id = ? AND level_no = ? LIMIT 1`,
      [ruleId, levelNo],
    )
    const row = rows[0]
    if (row?.escalate_to_kind && row?.escalate_to_value) {
      const target: ApproverTarget = { kind: row.escalate_to_kind, value: String(row.escalate_to_value) }
      const [resolved] = await resolveTargetToSteps(target, delegations)
      return { kind: target.kind, value: target.value, approverUserId: resolved?.approverUserId ?? null }
    }
  }
  if (fallbackUserId) {
    return { kind: "user", value: String(fallbackUserId), approverUserId: resolveDelegate(fallbackUserId, delegations) }
  }
  return { kind: "dynamic", value: "escalation", approverUserId: null }
}

// ---------------------------------------------------------------------------
// Escalation sweep (time-based, opportunistic)
// ---------------------------------------------------------------------------

/**
 * Find pending steps at active levels that have outlived their escalation
 * window and spawn an escalation slot for each (idempotently — a step only
 * escalates once). Called opportunistically when the inbox is read so no
 * external scheduler is required.
 */
export async function sweepEscalations(tenantId: number): Promise<void> {
  const rows = await query<any[]>(
    `SELECT s.id, s.request_id, s.level_no, s.level_name, s.mode, s.quorum, s.activated_at, s.decision,
            r.rule_id,
            l.escalate_after_hours, l.escalate_to_kind, l.escalate_to_value
       FROM approval_request_steps s
       JOIN approval_requests r ON r.id = s.request_id AND r.tenant_id = ? AND r.status = 'pending'
       LEFT JOIN approval_rule_levels l ON l.rule_id = r.rule_id AND l.level_no = s.level_no
      WHERE s.decision = 'pending' AND s.level_no = r.current_level AND s.is_escalation = 0`,
    [tenantId],
  ).catch(() => [] as any[])
  if (!rows || rows.length === 0) return

  const delegations = await loadActiveDelegations(tenantId)
  const now = new Date()
  const overdue = computeEscalations(
    rows.map((r) => ({
      levelNo: Number(r.level_no),
      activatedAt: r.activated_at ? new Date(r.activated_at).toISOString() : null,
      escalateAfterHours: r.escalate_after_hours != null ? Number(r.escalate_after_hours) : null,
      escalateTo:
        r.escalate_to_kind && r.escalate_to_value ? { kind: r.escalate_to_kind, value: String(r.escalate_to_value) } : null,
      decision: "pending" as const,
    })),
    now,
  )
  // computeEscalations preserves order, so pair back by index.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const isOverdue = overdue.some(
      (o) =>
        o.levelNo === Number(row.level_no) &&
        o.activatedAt === (row.activated_at ? new Date(row.activated_at).toISOString() : null) &&
        o.escalateAfterHours === (row.escalate_after_hours != null ? Number(row.escalate_after_hours) : null),
    )
    if (!isOverdue) continue
    // Guard against re-escalating: skip when an escalation slot already exists.
    const already = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM approval_request_steps WHERE request_id = ? AND level_no = ? AND is_escalation = 1`,
      [row.request_id, row.level_no],
    )
    if (Number(already[0]?.c) > 0) continue
    const target: ApproverTarget = { kind: row.escalate_to_kind, value: String(row.escalate_to_value) }
    const [resolved] = await resolveTargetToSteps(target, delegations)
    await query(
      `INSERT INTO approval_request_steps
         (request_id, level_no, level_name, mode, quorum, target_kind, target_value, approver_user_id, activated_at, is_escalation)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [row.request_id, row.level_no, row.level_name, row.mode, row.quorum, target.kind, target.value, resolved?.approverUserId ?? null, now],
    )
    await logAction(Number(row.request_id), Number(row.id), "escalate", null, "System", {
      comment: `Auto-escalated after ${row.escalate_after_hours}h of inactivity.`,
      toUserId: resolved?.approverUserId ?? null,
    })
  }
}

// ---------------------------------------------------------------------------
// Simulation (Phase 4 — test complex chains without persisting)
// ---------------------------------------------------------------------------

export async function simulateChain(ctx: ApprovalContext): Promise<{
  rule: ApprovalRuleRecord | null
  chain: PlannedStep[]
}> {
  const rules = await listRules()
  const rule = selectRule(rules, ctx)
  return { rule: rule as ApprovalRuleRecord | null, chain: rule ? buildChain(rule) : [] }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function logAction(
  requestId: number,
  stepId: number | null,
  action: string,
  actorId: number | null,
  actorName: string | null,
  extra?: { fromUserId?: number | null; toUserId?: number | null; comment?: string | null },
): Promise<void> {
  try {
    await query(
      `INSERT INTO approval_step_actions (request_id, step_id, action, actor_id, actor_name, from_user_id, to_user_id, comment)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        requestId,
        stepId,
        action,
        actorId,
        actorName,
        extra?.fromUserId ?? null,
        extra?.toUserId ?? null,
        extra?.comment ?? null,
      ],
    )
  } catch (err) {
    console.error("[v0] approval logAction failed:", (err as Error).message)
  }
}
