import "server-only"
/**
 * SPEC 66 — Access reviews: the DB layer.
 * ---------------------------------------------------------------------------
 * Drives the pure model (lib/access-review-core.ts) against three self-healing,
 * tenant-scoped tables, following the same house pattern as
 * lib/temporary-access-store.ts and lib/api-keys-store.ts:
 *   - a self-healing schema (`ensureAccessReviewSchema`) so existing installs
 *     converge with no manual migration,
 *   - an explicit `tenant_id` predicate on every read/write (callers pass the
 *     effective tenant id resolved from the verified session or, for cron, the
 *     fanned-out tenant), so one tenant can never see or mutate another's
 *     reviews,
 *   - an append-only `access_review_audit` trail for the console.
 *
 * Subjects under review are SNAPSHOTTED from their live source of truth
 * (users, roles, permission overrides, temporary grants, API keys) when a
 * campaign is created, so the reviewer certifies exactly what existed at that
 * moment. Revocation is EXECUTED against the same sources where a safe,
 * reversible mechanism exists (suspend user, revoke grant, revoke key); role
 * and permission revocations are recorded as remediation actions rather than
 * blind destructive deletes.
 */
import { query } from "@/lib/db"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { recordActivity } from "@/lib/notifications"
import {
  type CampaignStatus,
  type DerivedCampaignStatus,
  type EscalationLevel,
  type ReviewDecision,
  type ReviewFrequency,
  type ReviewProgress,
  type ReviewSubjectType,
  computeProgress,
  computeStatus,
  escalationLevel,
  isReviewSubjectType,
  nextRunAt,
  subjectMeta,
} from "@/lib/access-review-core"

import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { suspendUser } from "@/lib/user-lifecycle"
import { listRoles } from "@/lib/role-store"
import { getUserMatrix } from "@/lib/permission-store"
import { listGrants, revokeGrant } from "@/lib/temporary-access-store"
import { listApiKeys, revokeApiKey } from "@/lib/api-keys-store"

export class AccessReviewError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "AccessReviewError"
    this.status = status
  }
}

export type Actor = { userId: number; name?: string | null; email?: string | null }

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`access_review_campaigns\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(160) NOT NULL,
      \`description\` VARCHAR(600) DEFAULT NULL,
      \`scope_types\` VARCHAR(255) NOT NULL DEFAULT '',
      \`frequency\` ENUM('once','monthly','quarterly','semiannual','annual') NOT NULL DEFAULT 'once',
      \`status\` ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
      \`due_at\` DATETIME NOT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_by_name\` VARCHAR(190) DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`last_escalation\` TINYINT NOT NULL DEFAULT 0,
      \`next_run_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_arc_tenant\` (\`tenant_id\`),
      KEY \`idx_arc_status\` (\`status\`),
      KEY \`idx_arc_due\` (\`status\`, \`due_at\`),
      KEY \`idx_arc_next\` (\`next_run_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`access_review_items\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`campaign_id\` INT UNSIGNED NOT NULL,
      \`subject_type\` ENUM('user','role','permission','temporary_access','api_key','service_account') NOT NULL,
      \`subject_ref\` VARCHAR(64) NOT NULL,
      \`subject_label\` VARCHAR(255) NOT NULL,
      \`subject_detail\` TEXT DEFAULT NULL,
      \`decision\` ENUM('pending','approved','revoked','remediated') NOT NULL DEFAULT 'pending',
      \`note\` VARCHAR(1000) DEFAULT NULL,
      \`remediation\` VARCHAR(1000) DEFAULT NULL,
      \`execution\` VARCHAR(300) DEFAULT NULL,
      \`decided_by\` INT UNSIGNED DEFAULT NULL,
      \`decided_by_name\` VARCHAR(190) DEFAULT NULL,
      \`decided_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ari_tenant\` (\`tenant_id\`),
      KEY \`idx_ari_campaign\` (\`campaign_id\`),
      KEY \`idx_ari_decision\` (\`decision\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`access_review_audit\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`campaign_id\` INT UNSIGNED DEFAULT NULL,
      \`item_id\` INT UNSIGNED DEFAULT NULL,
      \`action\` VARCHAR(60) NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_name\` VARCHAR(190) DEFAULT NULL,
      \`detail\` TEXT DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ara_tenant\` (\`tenant_id\`),
      KEY \`idx_ara_campaign\` (\`campaign_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureAccessReviewSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewItem = {
  id: number
  campaignId: number
  subjectType: ReviewSubjectType
  subjectRef: string
  subjectLabel: string
  subjectDetail: Record<string, unknown> | null
  decision: ReviewDecision
  note: string | null
  remediation: string | null
  execution: string | null
  decidedBy: number | null
  decidedByName: string | null
  decidedAt: string | null
}

export type ReviewCampaign = {
  id: number
  name: string
  description: string | null
  scopeTypes: ReviewSubjectType[]
  frequency: ReviewFrequency
  storedStatus: CampaignStatus
  status: DerivedCampaignStatus
  dueAt: string
  createdBy: number | null
  createdByName: string | null
  completedAt: string | null
  nextRunAt: string | null
  createdAt: string
  progress: ReviewProgress
  escalation: EscalationLevel
}

export type AuditEntry = {
  id: number
  campaignId: number | null
  itemId: number | null
  action: string
  actorUserId: number | null
  actorName: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function parseScopeTypes(raw: string | null): ReviewSubjectType[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ReviewSubjectType => isReviewSubjectType(s))
}

// ---------------------------------------------------------------------------
// Subject resolvers — snapshot the live sources of truth
// ---------------------------------------------------------------------------

export type ResolvedSubject = {
  ref: string
  label: string
  detail: Record<string, unknown>
}

/**
 * Enumerate the current review candidates for one subject type. These reads
 * are the authoritative "what access exists right now" that a campaign
 * snapshots. Every source is already tenant-scoped by its own store.
 */
export async function resolveSubjects(tenantId: number, type: ReviewSubjectType): Promise<ResolvedSubject[]> {
  switch (type) {
    case "user": {
      const users = await listLifecycleUsers(tenantId)
      return users
        .filter((u) => u.lifecycleState === "active" || u.lifecycleState === "suspended")
        .map((u) => ({
          ref: String(u.id),
          label: u.name || u.email || `User #${u.id}`,
          detail: {
            email: u.email,
            role: u.tenantRole,
            lifecycleState: u.lifecycleState,
            mfaEnabled: u.mfaEnabled,
          },
        }))
    }
    case "role": {
      const roles = await listRoles(tenantId)
      return roles.map((r) => ({
        ref: String(r.id),
        label: r.name,
        detail: {
          description: r.description,
          isSystem: r.isSystem,
          memberCount: r.memberCount,
        },
      }))
    }
    case "permission": {
      // Users carrying a personal permission override on top of their roles —
      // the elevated grants most worth periodically re-certifying.
      const users = await listLifecycleUsers(tenantId)
      const out: ResolvedSubject[] = []
      for (const u of users) {
        if (u.lifecycleState === "deactivated") continue
        const matrix = await getUserMatrix(u.id)
        if (!matrix) continue
        const modules = Object.keys(matrix as Record<string, unknown>)
        out.push({
          ref: String(u.id),
          label: u.name || u.email || `User #${u.id}`,
          detail: {
            email: u.email,
            role: u.tenantRole,
            overrideModules: modules.length,
          },
        })
      }
      return out
    }
    case "temporary_access": {
      const grants = await listGrants(tenantId, { kind: "temporary" })
      return grants
        .filter((g) => g.status === "active" || g.status === "pending")
        .map((g) => ({
          ref: String(g.id),
          label: `${g.userName || g.userEmail || `User #${g.userId}`} · ${g.scope}`,
          detail: {
            userId: g.userId,
            status: g.status,
            grantedRole: g.grantedRole,
            expiresAt: g.expiresAt,
            reason: g.reason,
          },
        }))
    }
    case "api_key": {
      const keys = await listApiKeys(tenantId)
      return keys
        .filter((k) => k.status === "active")
        .map((k) => ({
          ref: String(k.id),
          label: `${k.name} (${k.key_prefix}…)`,
          detail: {
            environment: k.environment,
            scopes: k.scopes,
            lastUsedAt: k.last_used_at,
            expiresAt: k.expires_at,
          },
        }))
    }
    case "service_account": {
      // No dedicated service-account entity exists in this ERP, so we treat a
      // long-lived (non-expiring) live API key as a machine/service identity —
      // exactly the unattended credential an access review must catch and
      // force to rotate. Keys with an expiry rotate themselves and are covered
      // by the `api_key` subject instead.
      const keys = await listApiKeys(tenantId)
      return keys
        .filter((k) => k.status === "active" && k.environment === "live" && !k.expires_at)
        .map((k) => ({
          ref: String(k.id),
          label: `${k.name} (${k.key_prefix}…)`,
          detail: {
            scopes: k.scopes,
            lastUsedAt: k.last_used_at,
            createdBy: k.created_by,
            neverExpires: true,
          },
        }))
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapItem(row: any): ReviewItem {
  return {
    id: Number(row.id),
    campaignId: Number(row.campaign_id),
    subjectType: row.subject_type,
    subjectRef: String(row.subject_ref),
    subjectLabel: row.subject_label,
    subjectDetail: parseJson<Record<string, unknown>>(row.subject_detail),
    decision: row.decision,
    note: row.note,
    remediation: row.remediation,
    execution: row.execution,
    decidedBy: row.decided_by != null ? Number(row.decided_by) : null,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
  }
}

function mapCampaign(row: any, items: ReviewItem[], now: Date): ReviewCampaign {
  const progress = computeProgress(items)
  const storedStatus: CampaignStatus = row.status
  const status = computeStatus(storedStatus, progress, row.due_at, now)
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    scopeTypes: parseScopeTypes(row.scope_types),
    frequency: row.frequency,
    storedStatus,
    status,
    dueAt: row.due_at,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdByName: row.created_by_name,
    completedAt: row.completed_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    progress,
    escalation: status === "overdue" ? escalationLevel(row.due_at, now) : 0,
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function appendAudit(
  tenantId: number,
  entry: {
    campaignId?: number | null
    itemId?: number | null
    action: string
    actor?: Actor | null
    detail?: Record<string, unknown> | null
  },
): Promise<void> {
  await query(
    `INSERT INTO \`access_review_audit\`
       (\`tenant_id\`, \`campaign_id\`, \`item_id\`, \`action\`, \`actor_user_id\`, \`actor_name\`, \`detail\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      entry.campaignId ?? null,
      entry.itemId ?? null,
      entry.action,
      entry.actor?.userId ?? null,
      entry.actor?.name ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  )
}

export async function getAuditTrail(tenantId: number, campaignId?: number, limit = 200): Promise<AuditEntry[]> {
  await ensureAccessReviewSchema()
  const cap = Math.min(Math.max(1, limit), 500)
  const params: any[] = [tenantId]
  let sql = `SELECT * FROM \`access_review_audit\` WHERE tenant_id = ?`
  if (campaignId != null) {
    sql += ` AND campaign_id = ?`
    params.push(campaignId)
  }
  sql += ` ORDER BY id DESC LIMIT ?`
  params.push(cap)
  const rows = await query<any[]>(sql, params)
  return rows.map((r) => ({
    id: Number(r.id),
    campaignId: r.campaign_id != null ? Number(r.campaign_id) : null,
    itemId: r.item_id != null ? Number(r.item_id) : null,
    action: r.action,
    actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
    actorName: r.actor_name,
    detail: parseJson<Record<string, unknown>>(r.detail),
    createdAt: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadItems(tenantId: number, campaignId: number): Promise<ReviewItem[]> {
  const rows = await query<any[]>(
    `SELECT * FROM \`access_review_items\` WHERE tenant_id = ? AND campaign_id = ?
      ORDER BY FIELD(decision,'pending','remediated','revoked','approved'), subject_type, id`,
    [tenantId, campaignId],
  )
  return rows.map(mapItem)
}

export async function listCampaigns(tenantId: number): Promise<ReviewCampaign[]> {
  await ensureAccessReviewSchema()
  const now = new Date()
  const rows = await query<any[]>(
    `SELECT * FROM \`access_review_campaigns\` WHERE tenant_id = ?
      ORDER BY FIELD(status,'active','completed','cancelled'), due_at ASC, id DESC`,
    [tenantId],
  )
  const campaigns: ReviewCampaign[] = []
  for (const row of rows) {
    const items = await loadItems(tenantId, Number(row.id))
    campaigns.push(mapCampaign(row, items, now))
  }
  return campaigns
}

export async function getCampaign(
  tenantId: number,
  id: number,
): Promise<{ campaign: ReviewCampaign; items: ReviewItem[] } | null> {
  await ensureAccessReviewSchema()
  const rows = await query<any[]>(
    `SELECT * FROM \`access_review_campaigns\` WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, id],
  )
  if (!rows[0]) return null
  const items = await loadItems(tenantId, id)
  return { campaign: mapCampaign(rows[0], items, new Date()), items }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateCampaignInput = {
  name: string
  description?: string | null
  scopeTypes: ReviewSubjectType[]
  frequency: ReviewFrequency
  /** Days the reviewer has to complete the review. Defaults to 14. */
  dueInDays?: number
}

export async function createCampaign(
  tenantId: number,
  actor: Actor,
  input: CreateCampaignInput,
): Promise<ReviewCampaign> {
  await ensureAccessReviewSchema()

  const name = (input.name ?? "").trim()
  if (!name) throw new AccessReviewError("A campaign name is required")

  const scopeTypes = Array.from(new Set((input.scopeTypes ?? []).filter(isReviewSubjectType)))
  if (scopeTypes.length === 0) throw new AccessReviewError("Select at least one thing to review")

  const dueInDays = Number.isFinite(input.dueInDays) ? Math.max(1, Math.min(180, Number(input.dueInDays))) : 14
  const now = new Date()
  const dueAt = new Date(now.getTime() + dueInDays * 24 * 60 * 60 * 1000)
  const next = nextRunAt(input.frequency, now)

  const res = await query<any>(
    `INSERT INTO \`access_review_campaigns\`
       (\`tenant_id\`, \`name\`, \`description\`, \`scope_types\`, \`frequency\`, \`status\`, \`due_at\`,
        \`created_by\`, \`created_by_name\`, \`next_run_at\`)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      tenantId,
      name,
      input.description?.trim() || null,
      scopeTypes.join(","),
      input.frequency,
      dueAt,
      actor.userId ?? null,
      actor.name ?? null,
      next,
    ],
  )
  const campaignId = Number(res?.insertId ?? 0)

  // Snapshot every subject in scope into review items.
  let itemCount = 0
  for (const type of scopeTypes) {
    const subjects = await resolveSubjects(tenantId, type)
    for (const s of subjects) {
      await query(
        `INSERT INTO \`access_review_items\`
           (\`tenant_id\`, \`campaign_id\`, \`subject_type\`, \`subject_ref\`, \`subject_label\`, \`subject_detail\`)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, campaignId, type, s.ref, s.label.slice(0, 255), JSON.stringify(s.detail)],
      )
      itemCount++
    }
  }

  await appendAudit(tenantId, {
    campaignId,
    action: "campaign_created",
    actor,
    detail: { name, scopeTypes, itemCount, dueAt: dueAt.toISOString(), frequency: input.frequency },
  })
  await recordSecurityEvent({
    tenantId,
    category: "access_review",
    action: "campaign_created",
    outcome: "success",
    actorUserId: actor.userId ?? null,
    actorName: actor.name ?? null,
    detail: { campaignId, name, scopeTypes, itemCount },
  })
  await recordActivity({
    action: "create",
    title: `Access review "${name}" started`,
    body: `${itemCount} item(s) across ${scopeTypes.length} categor${scopeTypes.length === 1 ? "y" : "ies"}`,
    link: "/admin/security/access-reviews",
    actor,
  }).catch(() => {})

  const created = await getCampaign(tenantId, campaignId)
  if (!created) throw new AccessReviewError("Failed to create campaign", 500)
  return created.campaign
}

// ---------------------------------------------------------------------------
// Decisions — approve / revoke / remediate
// ---------------------------------------------------------------------------

/**
 * Execute the real-world side of a revocation where a safe, reversible
 * mechanism exists. Returns a short human summary of what happened, or null
 * when the subject type has no automatic action (role/permission), in which
 * case the decision is still recorded and surfaced for manual remediation.
 */
async function executeRevocation(
  tenantId: number,
  item: ReviewItem,
  actor: Actor,
  reason: string,
): Promise<string> {
  switch (item.subjectType) {
    case "user": {
      const userId = Number(item.subjectRef)
      await suspendUser(tenantId, userId, reason || "Revoked during access review", {
        userId: actor.userId,
        name: actor.name ?? null,
        email: actor.email ?? null,
      })
      return "User suspended"
    }
    case "temporary_access": {
      const grantId = Number(item.subjectRef)
      await revokeGrant(tenantId, grantId, actor, reason || "Revoked during access review")
      return "Temporary grant revoked"
    }
    case "api_key":
    case "service_account": {
      const keyId = Number(item.subjectRef)
      await revokeApiKey(tenantId, keyId, actor.userId ?? null)
      return "API key revoked"
    }
    case "role":
      return "Flagged for manual role change"
    case "permission":
      return "Flagged for manual permission removal"
    default:
      return "Recorded"
  }
}

export async function recordDecision(
  tenantId: number,
  actor: Actor,
  itemId: number,
  decision: Exclude<ReviewDecision, "pending">,
  opts: { note?: string | null; remediation?: string | null } = {},
): Promise<ReviewItem> {
  await ensureAccessReviewSchema()

  const rows = await query<any[]>(
    `SELECT * FROM \`access_review_items\` WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, itemId],
  )
  if (!rows[0]) throw new AccessReviewError("Review item not found", 404)
  const item = mapItem(rows[0])

  const campaignRows = await query<any[]>(
    `SELECT status FROM \`access_review_campaigns\` WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, item.campaignId],
  )
  if (campaignRows[0]?.status === "cancelled") {
    throw new AccessReviewError("This campaign has been cancelled", 409)
  }

  let execution: string | null = null
  if (decision === "revoked") {
    try {
      execution = await executeRevocation(tenantId, item, actor, opts.note ?? "")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Revocation failed"
      throw new AccessReviewError(`Could not revoke access: ${message}`, 409)
    }
  }

  await query(
    `UPDATE \`access_review_items\`
        SET decision = ?, note = ?, remediation = ?, execution = ?,
            decided_by = ?, decided_by_name = ?, decided_at = NOW()
      WHERE tenant_id = ? AND id = ?`,
    [
      decision,
      opts.note?.slice(0, 1000) ?? null,
      opts.remediation?.slice(0, 1000) ?? null,
      execution,
      actor.userId ?? null,
      actor.name ?? null,
      tenantId,
      itemId,
    ],
  )

  await appendAudit(tenantId, {
    campaignId: item.campaignId,
    itemId,
    action: `item_${decision}`,
    actor,
    detail: {
      subjectType: item.subjectType,
      subjectRef: item.subjectRef,
      subjectLabel: item.subjectLabel,
      execution,
      note: opts.note ?? null,
    },
  })
  await recordSecurityEvent({
    tenantId,
    category: "access_review",
    action: `item_${decision}`,
    outcome: decision === "revoked" ? "revoked" : "success",
    actorUserId: actor.userId ?? null,
    actorName: actor.name ?? null,
    detail: { itemId, subjectType: item.subjectType, subjectLabel: item.subjectLabel, execution },
  })

  // Auto-complete the campaign once every item is resolved.
  await maybeCompleteCampaign(tenantId, item.campaignId, actor)

  const updated = await query<any[]>(
    `SELECT * FROM \`access_review_items\` WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, itemId],
  )
  return mapItem(updated[0])
}

async function maybeCompleteCampaign(tenantId: number, campaignId: number, actor: Actor): Promise<void> {
  const items = await loadItems(tenantId, campaignId)
  const progress = computeProgress(items)
  if (!progress.complete) return
  const res = await query<any>(
    `UPDATE \`access_review_campaigns\`
        SET status = 'completed', completed_at = NOW()
      WHERE tenant_id = ? AND id = ? AND status = 'active'`,
    [tenantId, campaignId],
  )
  if (Number(res?.affectedRows ?? 0) > 0) {
    await appendAudit(tenantId, {
      campaignId,
      action: "campaign_completed",
      actor,
      detail: { ...progress },
    })
    await recordActivity({
      action: "update",
      title: "Access review completed",
      body: `${progress.total} item(s) reviewed`,
      link: "/admin/security/access-reviews",
      actor,
    }).catch(() => {})
  }
}

export async function cancelCampaign(tenantId: number, actor: Actor, campaignId: number): Promise<void> {
  await ensureAccessReviewSchema()
  const res = await query<any>(
    `UPDATE \`access_review_campaigns\` SET status = 'cancelled'
      WHERE tenant_id = ? AND id = ? AND status = 'active'`,
    [tenantId, campaignId],
  )
  if (Number(res?.affectedRows ?? 0) === 0) {
    throw new AccessReviewError("Only an active campaign can be cancelled", 409)
  }
  await appendAudit(tenantId, { campaignId, action: "campaign_cancelled", actor })
}

// ---------------------------------------------------------------------------
// Scheduled workflow + overdue / escalation engine (driven by cron)
// ---------------------------------------------------------------------------

export type SweepResult = {
  spawned: number
  escalated: number
}

/**
 * One idempotent pass for a single tenant:
 *   1. Recurring campaigns whose `next_run_at` has arrived spawn a fresh
 *      campaign snapshotting the current access, and their own next occurrence
 *      is advanced (so a lapsed schedule never spawns a backlog).
 *   2. Open campaigns past their due date raise their escalation tier when it
 *      increases, notifying the reviewer / owner and recording the escalation.
 * Re-running when nothing is due changes nothing.
 */
export async function sweepTenant(tenantId: number, systemActor: Actor): Promise<SweepResult> {
  await ensureAccessReviewSchema()
  const now = new Date()
  let spawned = 0
  let escalated = 0

  // 1. Spawn due recurring campaigns.
  const due = await query<any[]>(
    `SELECT * FROM \`access_review_campaigns\`
      WHERE tenant_id = ? AND frequency <> 'once' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC`,
    [tenantId, now],
  )
  for (const row of due) {
    const scopeTypes = parseScopeTypes(row.scope_types)
    if (scopeTypes.length > 0) {
      await createCampaign(tenantId, systemActor, {
        name: `${row.name} · ${now.toISOString().slice(0, 10)}`,
        description: row.description,
        scopeTypes,
        frequency: "once", // the spawned instance is a one-time run; the template keeps recurring
      })
      spawned++
    }
    const advanced = nextRunAt(row.frequency as ReviewFrequency, now)
    await query(
      `UPDATE \`access_review_campaigns\` SET next_run_at = ? WHERE tenant_id = ? AND id = ?`,
      [advanced, tenantId, Number(row.id)],
    )
  }

  // 2. Escalate overdue open campaigns.
  const open = await query<any[]>(
    `SELECT * FROM \`access_review_campaigns\`
      WHERE tenant_id = ? AND status = 'active' AND due_at < ?`,
    [tenantId, now],
  )
  for (const row of open) {
    const level = escalationLevel(row.due_at, now)
    const prev = Number(row.last_escalation ?? 0)
    if (level > prev) {
      await query(
        `UPDATE \`access_review_campaigns\` SET last_escalation = ? WHERE tenant_id = ? AND id = ?`,
        [level, tenantId, Number(row.id)],
      )
      await appendAudit(tenantId, {
        campaignId: Number(row.id),
        action: "campaign_escalated",
        actor: systemActor,
        detail: { level, daysOverdue: Math.floor((now.getTime() - new Date(row.due_at).getTime()) / 86400000) },
      })
      await recordSecurityEvent({
        tenantId,
        category: "access_review",
        action: "campaign_escalated",
        outcome: "warning",
        detail: { campaignId: Number(row.id), name: row.name, level },
      })
      await recordActivity({
        action: "update",
        title: `Access review "${row.name}" is overdue`,
        body: level >= 3 ? "Flagged as a security risk" : level >= 2 ? "Escalated to the tenant owner" : "Reviewer reminded",
        link: "/admin/security/access-reviews",
        actor: systemActor,
      }).catch(() => {})
      escalated++
    }
  }

  return { spawned, escalated }
}
