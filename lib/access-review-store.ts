import "server-only"

import { query, withTransaction } from "@/lib/db"
import { recordSecurityEvent } from "@/lib/security-audit-store"

export const REVIEW_SCOPES = ["users", "roles", "permissions", "temporary_access", "api_keys", "service_accounts"] as const
export type ReviewScope = (typeof REVIEW_SCOPES)[number]
export type ReviewDecision = "pending" | "approved" | "revoked" | "remediated"
export type ReviewStatus = "draft" | "open" | "completed" | "overdue" | "cancelled"
export type ReviewActor = { userId: number; name?: string | null; email?: string | null }

export type AccessReviewItem = {
  id: number
  campaignId: number
  scope: ReviewScope
  subjectId: number | null
  subjectName: string
  subjectEmail: string | null
  access: string
  decision: ReviewDecision
  comment: string | null
  decidedAt: string | null
}

export type AccessReviewCampaign = {
  id: number
  tenantId: number
  name: string
  reviewerId: number
  reviewerName: string | null
  startAt: string
  dueAt: string
  recurrence: string
  status: ReviewStatus
  escalationLevel: number
  escalatedAt: string | null
  createdAt: string
  items: AccessReviewItem[]
}

type CampaignRow = Record<string, any>
type ItemRow = Record<string, any>
let ensured: Promise<void> | null = null

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS access_review_campaigns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    name VARCHAR(190) NOT NULL,
    reviewer_id INT UNSIGNED NOT NULL,
    start_at DATETIME NOT NULL,
    due_at DATETIME NOT NULL,
    recurrence VARCHAR(24) NOT NULL DEFAULT 'one_time',
    status ENUM('draft','open','completed','overdue','cancelled') NOT NULL DEFAULT 'open',
    escalation_level TINYINT UNSIGNED NOT NULL DEFAULT 0,
    escalated_at DATETIME NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_arc_tenant_status (tenant_id,status), KEY idx_arc_due (status,due_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS access_review_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    campaign_id BIGINT UNSIGNED NOT NULL,
    tenant_id INT UNSIGNED NOT NULL,
    scope VARCHAR(32) NOT NULL,
    subject_id INT UNSIGNED NULL,
    subject_name VARCHAR(190) NOT NULL,
    subject_email VARCHAR(190) NULL,
    access_snapshot VARCHAR(500) NOT NULL,
    decision ENUM('pending','approved','revoked','remediated') NOT NULL DEFAULT 'pending',
    comment VARCHAR(1000) NULL,
    decided_by INT UNSIGNED NULL,
    decided_at DATETIME NULL,
    PRIMARY KEY (id), KEY idx_ari_campaign (campaign_id), KEY idx_ari_tenant (tenant_id),
    CONSTRAINT fk_ari_campaign FOREIGN KEY (campaign_id) REFERENCES access_review_campaigns(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}
export function ensureAccessReviewSchema() { if (!ensured) ensured = ensureSchema().catch((e) => { ensured = null; throw e }); return ensured }

function campaign(row: CampaignRow, items: AccessReviewItem[]): AccessReviewCampaign { return { id: Number(row.id), tenantId: Number(row.tenant_id), name: row.name, reviewerId: Number(row.reviewer_id), reviewerName: row.reviewer_name ?? null, startAt: row.start_at, dueAt: row.due_at, recurrence: row.recurrence, status: row.status, escalationLevel: Number(row.escalation_level ?? 0), escalatedAt: row.escalated_at ?? null, createdAt: row.created_at, items } }
function item(row: ItemRow): AccessReviewItem { return { id: Number(row.id), campaignId: Number(row.campaign_id), scope: row.scope, subjectId: row.subject_id == null ? null : Number(row.subject_id), subjectName: row.subject_name, subjectEmail: row.subject_email ?? null, access: row.access_snapshot, decision: row.decision, comment: row.comment ?? null, decidedAt: row.decided_at ?? null } }

export async function listAccessReviewCampaigns(tenantId: number) {
  await ensureAccessReviewSchema()
  await query(`UPDATE access_review_campaigns SET status='overdue', escalation_level=GREATEST(escalation_level, 1), escalated_at=COALESCE(escalated_at, NOW()) WHERE tenant_id=? AND status='open' AND due_at < NOW()`, [tenantId])
  const rows = await query<CampaignRow[]>(`SELECT c.*, u.name reviewer_name FROM access_review_campaigns c LEFT JOIN users u ON u.id=c.reviewer_id AND u.tenant_id=c.tenant_id WHERE c.tenant_id=? ORDER BY c.due_at ASC, c.id DESC`, [tenantId])
  const ids = rows.map((r) => Number(r.id)); if (!ids.length) return []
  const items = await query<ItemRow[]>(`SELECT * FROM access_review_items WHERE tenant_id=? AND campaign_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, [tenantId, ...ids])
  return rows.map((r) => campaign(r, items.filter((i) => Number(i.campaign_id) === Number(r.id)).map(item)))
}

export async function createAccessReviewCampaign(tenantId: number, actor: ReviewActor, input: { name: string; reviewerId: number; startAt: string; dueAt: string; recurrence: string; items: Array<{ scope: ReviewScope; subjectId?: number | null; subjectName: string; subjectEmail?: string | null; access: string }> }) {
  await ensureAccessReviewSchema()
  if (!input.name.trim() || input.name.length > 190) throw new Error("Campaign name is required")
  if (!Number.isInteger(input.reviewerId) || input.items.length === 0) throw new Error("A reviewer and at least one access item are required")
  const start = new Date(input.startAt), due = new Date(input.dueAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(due.getTime()) || due <= start) throw new Error("Due date must be after the start date")
  const id = await withTransaction(async (conn: any) => {
    const [result] = await conn.execute(`INSERT INTO access_review_campaigns (tenant_id,name,reviewer_id,start_at,due_at,recurrence,status,created_by) VALUES (?,?,?,?,?,?, 'open',?)`, [tenantId, input.name.trim(), input.reviewerId, start, due, input.recurrence, actor.userId])
    const campaignId = Number(result.insertId)
    for (const i of input.items) await conn.execute(`INSERT INTO access_review_items (campaign_id,tenant_id,scope,subject_id,subject_name,subject_email,access_snapshot) VALUES (?,?,?,?,?,?,?)`, [campaignId, tenantId, i.scope, i.subjectId ?? null, i.subjectName, i.subjectEmail ?? null, i.access])
    return campaignId
  })
  await recordSecurityEvent({ tenantId, category: "access_policy", action: "access_review_created", outcome: "created", actorUserId: actor.userId, actorName: actor.name, detail: { campaignId: id, itemCount: input.items.length } })
  return id
}

export async function decideAccessReviewItem(tenantId: number, actor: ReviewActor, itemId: number, decision: Exclude<ReviewDecision, "pending">, comment?: string) {
  await ensureAccessReviewSchema()
  if (!Number.isInteger(itemId) || !comment && decision === "remediated") throw new Error("A remediation comment is required")
  const rows = await query<ItemRow[]>(`SELECT * FROM access_review_items WHERE id=? AND tenant_id=? LIMIT 1`, [itemId, tenantId]); const current = rows[0]; if (!current) throw new Error("Review item not found")
  await query(`UPDATE access_review_items SET decision=?, comment=?, decided_by=?, decided_at=NOW() WHERE id=? AND tenant_id=? AND decision='pending'`, [decision, comment?.trim() || null, actor.userId, itemId, tenantId])
  await query(`UPDATE access_review_campaigns c SET status=CASE WHEN NOT EXISTS (SELECT 1 FROM access_review_items i WHERE i.campaign_id=c.id AND i.decision='pending') THEN 'completed' ELSE c.status END WHERE c.id=? AND c.tenant_id=?`, [current.campaign_id, tenantId])
  await recordSecurityEvent({ tenantId, category: "access_policy", action: `access_review_${decision}`, outcome: decision === "approved" ? "approved" : decision === "revoked" ? "revoked" : "updated", actorUserId: actor.userId, actorName: actor.name, subjectEmail: current.subject_email, detail: { itemId, campaignId: current.campaign_id, comment: comment?.trim() || null } })
}

export async function escalateOverdueAccessReviews() { await ensureAccessReviewSchema(); const [result] = await query<any>(`UPDATE access_review_campaigns SET escalation_level=LEAST(escalation_level+1,3), escalated_at=NOW() WHERE status IN ('open','overdue') AND due_at < NOW() AND escalation_level < 3`); return Number(result?.affectedRows ?? 0) }
export async function applyReviewDecision(tenantId: number, itemId: number, decision: ReviewDecision) { if (decision !== "revoked") return; const rows = await query<any[]>(`SELECT subject_id,scope FROM access_review_items WHERE id=? AND tenant_id=?`, [itemId, tenantId]); if (rows[0]?.scope === "temporary_access" && rows[0].subject_id) await query(`UPDATE temporary_access_grants SET status='revoked', ended_at=NOW(), end_reason='Access review revoked' WHERE tenant_id=? AND user_id=? AND status IN ('pending','active')`, [tenantId, rows[0].subject_id]) }

export async function listReviewableUsers(tenantId: number) { return query<any[]>(`SELECT id,name,email,COALESCE(tenant_role,role,'employee') role FROM users WHERE tenant_id=? AND lifecycle_state='active' ORDER BY name`, [tenantId]) }

export async function ensureAccessReviewMigration() { return ensureAccessReviewSchema() }
