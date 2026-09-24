import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { ensureLeadLifecycleSchema, recordAudit, notify } from "@/lib/sales/lead-lifecycle"

/**
 * SPEC 115 — CRM Deal Pipeline.
 *
 * Configurable deal pipelines built on top of the existing Sales CRM. A
 * pipeline is an ordered list of stages; each stage carries a default win
 * probability and can be flagged as the terminal Won / Lost stage or as
 * requiring approval before a deal may be closed from it. Deals live on a
 * single row and carry expected value, owner, team, close date and approval
 * state; stage moves, wins, losses and approvals are all funnelled through the
 * functions here so there is one source of truth (mirrors lead-lifecycle.ts).
 *
 * Audit + in-app notifications reuse the Sales tables created by
 * `ensureLeadLifecycleSchema` (sales_audit_log / sales_notifications).
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const DEAL_STATUSES = ["Open", "Won", "Lost"] as const
export type DealStatus = (typeof DEAL_STATUSES)[number]

export const APPROVAL_STATUSES = ["None", "Pending", "Approved", "Rejected"] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const DEAL_LOST_REASONS = [
  "Budget",
  "Timing",
  "Competitor",
  "No decision",
  "No response",
  "Not a fit",
  "Lost to status quo",
  "Other",
] as const

/** Stages seeded for the default pipeline on first run. */
const DEFAULT_STAGES: Array<{
  name: string
  probability: number
  is_won?: boolean
  is_lost?: boolean
  requires_approval?: boolean
}> = [
  { name: "Qualification", probability: 10 },
  { name: "Needs Analysis", probability: 25 },
  { name: "Proposal", probability: 50 },
  { name: "Negotiation", probability: 75, requires_approval: true },
  { name: "Closed Won", probability: 100, is_won: true },
  { name: "Closed Lost", probability: 0, is_lost: true },
]

export class DealConflictError extends Error {
  constructor(message = "This deal was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "DealConflictError"
  }
}

export class DealNotFoundError extends Error {
  constructor(message = "Deal not found") {
    super(message)
    this.name = "DealNotFoundError"
  }
}

export class DealValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DealValidationError"
  }
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal
// ---------------------------------------------------------------------------

let schemaEnsured = false

export async function ensureDealPipelineSchema(): Promise<void> {
  if (schemaEnsured) return
  // Guarantees sales_audit_log / sales_notifications exist for recordAudit/notify.
  await ensureLeadLifecycleSchema()

  try {
    await query(`CREATE TABLE IF NOT EXISTS \`sales_pipelines\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(120) NOT NULL,
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_pipeline_active\` (\`is_active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_pipeline_stages\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`pipeline_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`sort_order\` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      \`probability\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
      \`is_won\` TINYINT(1) NOT NULL DEFAULT 0,
      \`is_lost\` TINYINT(1) NOT NULL DEFAULT 0,
      \`requires_approval\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_stage_pipeline\` (\`pipeline_id\`, \`sort_order\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_deals\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`deal_code\` VARCHAR(30) DEFAULT NULL,
      \`pipeline_id\` INT UNSIGNED NOT NULL,
      \`stage_id\` INT UNSIGNED NOT NULL,
      \`title\` VARCHAR(200) NOT NULL,
      \`company_id\` INT UNSIGNED DEFAULT NULL,
      \`company_name\` VARCHAR(200) DEFAULT NULL,
      \`contact_person\` VARCHAR(150) DEFAULT NULL,
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`team_id\` INT UNSIGNED DEFAULT NULL,
      \`expected_value\` DECIMAL(14,2) NOT NULL DEFAULT 0,
      \`currency\` VARCHAR(8) NOT NULL DEFAULT 'INR',
      \`probability\` TINYINT UNSIGNED DEFAULT NULL,
      \`expected_close_date\` DATE DEFAULT NULL,
      \`status\` ENUM('Open','Won','Lost') NOT NULL DEFAULT 'Open',
      \`approval_status\` ENUM('None','Pending','Approved','Rejected') NOT NULL DEFAULT 'None',
      \`approval_note\` VARCHAR(500) DEFAULT NULL,
      \`approved_by\` INT UNSIGNED DEFAULT NULL,
      \`approval_requested_at\` DATETIME DEFAULT NULL,
      \`approval_decided_at\` DATETIME DEFAULT NULL,
      \`won_at\` DATETIME DEFAULT NULL,
      \`won_value\` DECIMAL(14,2) DEFAULT NULL,
      \`lost_at\` DATETIME DEFAULT NULL,
      \`lost_reason\` VARCHAR(120) DEFAULT NULL,
      \`lost_notes\` TEXT DEFAULT NULL,
      \`source_lead_id\` INT UNSIGNED DEFAULT NULL,
      \`notes\` TEXT DEFAULT NULL,
      \`row_version\` INT UNSIGNED NOT NULL DEFAULT 1,
      \`archived_at\` DATETIME DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_deal_code\` (\`deal_code\`),
      KEY \`idx_deal_pipeline_stage\` (\`pipeline_id\`, \`stage_id\`),
      KEY \`idx_deal_owner\` (\`owner_id\`, \`status\`),
      KEY \`idx_deal_status\` (\`status\`, \`archived_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await seedDefaultPipeline()
    schemaEnsured = true
  } catch (error) {
    console.error("[deal-pipeline] ensureSchema failed", error)
  }
}

async function seedDefaultPipeline(): Promise<void> {
  const existing = await query<any[]>("SELECT id FROM sales_pipelines LIMIT 1")
  if (existing.length > 0) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query(
      `INSERT INTO sales_pipelines (name, description, is_default, is_active) VALUES (?, ?, 1, 1)`,
      ["Sales Pipeline", "Default deal pipeline"],
    )
    const pipelineId = Number((res as any).insertId)
    await insertStages(conn, pipelineId, DEFAULT_STAGES)
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    console.error("[deal-pipeline] seed default pipeline failed", error)
  } finally {
    conn.release()
  }
}

async function insertStages(
  conn: PoolConnection,
  pipelineId: number,
  stages: Array<{ name: string; probability: number; is_won?: boolean; is_lost?: boolean; requires_approval?: boolean }>,
): Promise<void> {
  let order = 0
  for (const s of stages) {
    await conn.query(
      `INSERT INTO sales_pipeline_stages
        (pipeline_id, name, sort_order, probability, is_won, is_lost, requires_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        pipelineId,
        s.name,
        order++,
        Math.max(0, Math.min(100, Math.round(s.probability))),
        s.is_won ? 1 : 0,
        s.is_lost ? 1 : 0,
        s.requires_approval ? 1 : 0,
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineStage = {
  id: number
  pipeline_id: number
  name: string
  sort_order: number
  probability: number
  is_won: number
  is_lost: number
  requires_approval: number
}

export type Pipeline = {
  id: number
  name: string
  description: string | null
  is_default: number
  is_active: number
  stages: PipelineStage[]
}

export type DealRecord = {
  id: number
  deal_code: string | null
  pipeline_id: number
  stage_id: number
  title: string
  company_id: number | null
  company_name: string | null
  contact_person: string | null
  owner_id: number | null
  owner_name?: string | null
  team_id: number | null
  team_name?: string | null
  expected_value: string
  currency: string
  probability: number | null
  expected_close_date: string | null
  status: DealStatus
  approval_status: ApprovalStatus
  lost_reason: string | null
  row_version: number
  [key: string]: unknown
}

type Actor = number | null | undefined

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPipelines(): Promise<Pipeline[]> {
  await ensureDealPipelineSchema()
  const pipelines = await query<any[]>(
    "SELECT * FROM sales_pipelines WHERE is_active = 1 ORDER BY is_default DESC, name ASC",
  )
  if (pipelines.length === 0) return []
  const ids = pipelines.map((p) => p.id)
  const stages = await query<PipelineStage[]>(
    `SELECT * FROM sales_pipeline_stages WHERE pipeline_id IN (${ids.map(() => "?").join(",")})
     ORDER BY sort_order ASC, id ASC`,
    ids,
  )
  return pipelines.map((p) => ({
    ...p,
    stages: stages.filter((s) => s.pipeline_id === p.id),
  }))
}

export async function getStage(stageId: number): Promise<PipelineStage | null> {
  const rows = await query<PipelineStage[]>("SELECT * FROM sales_pipeline_stages WHERE id = ? LIMIT 1", [stageId])
  return rows[0] ?? null
}

export async function getDeal(id: number): Promise<DealRecord | null> {
  const rows = await query<DealRecord[]>("SELECT * FROM sales_deals WHERE id = ? LIMIT 1", [id])
  return rows[0] ?? null
}

/** Assignable owners + teams for the deal form. */
export async function getDealMeta(): Promise<{
  users: Array<{ id: number; name: string }>
  teams: Array<{ id: number; name: string }>
}> {
  await ensureDealPipelineSchema()
  const users = await query<any[]>(
    "SELECT id, name FROM users WHERE status IS NULL OR status = 'active' ORDER BY name ASC",
  ).catch(() => [])
  let teams: any[] = []
  try {
    teams = await query<any[]>("SELECT id, name FROM org_units ORDER BY name ASC")
  } catch {
    teams = []
  }
  return {
    users: users.map((u) => ({ id: Number(u.id), name: String(u.name) })),
    teams: teams.map((t) => ({ id: Number(t.id), name: String(t.name) })),
  }
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export async function createPipeline(
  input: { name: string; description?: string | null; stages?: Array<{ name: string; probability: number; is_won?: boolean; is_lost?: boolean; requires_approval?: boolean }> },
  actorId: Actor,
): Promise<{ id: number }> {
  await ensureDealPipelineSchema()
  const name = String(input.name || "").trim()
  if (!name) throw new DealValidationError("Pipeline name is required")

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query(
      `INSERT INTO sales_pipelines (name, description, is_default, is_active, created_by) VALUES (?, ?, 0, 1, ?)`,
      [name, input.description ?? null, actorId ?? null],
    )
    const pipelineId = Number((res as any).insertId)
    const stages = input.stages && input.stages.length > 0 ? input.stages : DEFAULT_STAGES
    await insertStages(conn, pipelineId, stages)
    await recordAudit(conn, {
      entityType: "deal_pipeline",
      entityId: pipelineId,
      action: "create",
      summary: `Pipeline "${name}" created`,
      actorId,
    })
    await conn.commit()
    return { id: pipelineId }
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Deal writes
// ---------------------------------------------------------------------------

async function nextDealCode(conn: PoolConnection): Promise<string> {
  const [rows] = await conn.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(deal_code, 6) AS UNSIGNED)), 0) AS max_num FROM sales_deals",
  )
  const currentMax = Number((rows as any[])[0]?.max_num || 0)
  return `DEAL-${String(currentMax + 1).padStart(5, "0")}`
}

export async function createDeal(input: Record<string, any>, actorId: Actor): Promise<{ id: number; deal_code: string }> {
  await ensureDealPipelineSchema()

  const title = String(input.title || "").trim()
  if (!title) throw new DealValidationError("Deal title is required")

  const pipelineId = Number(input.pipeline_id)
  if (!Number.isInteger(pipelineId) || pipelineId <= 0) throw new DealValidationError("A pipeline is required")

  const pipelineStages = await query<PipelineStage[]>(
    "SELECT * FROM sales_pipeline_stages WHERE pipeline_id = ? ORDER BY sort_order ASC",
    [pipelineId],
  )
  if (pipelineStages.length === 0) throw new DealValidationError("Selected pipeline has no stages")

  const stageId = input.stage_id ? Number(input.stage_id) : pipelineStages[0].id
  const stage = pipelineStages.find((s) => s.id === stageId)
  if (!stage) throw new DealValidationError("Invalid stage for this pipeline")

  const expectedValue = clampMoney(input.expected_value)
  const probability = input.probability != null && input.probability !== "" ? clampPct(input.probability) : stage.probability

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const code = await nextDealCode(conn)
    const [res] = await conn.query(
      `INSERT INTO sales_deals
        (deal_code, pipeline_id, stage_id, title, company_id, company_name, contact_person,
         owner_id, team_id, expected_value, currency, probability, expected_close_date,
         status, source_lead_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?)`,
      [
        code,
        pipelineId,
        stageId,
        title,
        input.company_id ? Number(input.company_id) : null,
        input.company_name ?? null,
        input.contact_person ?? null,
        input.owner_id ? Number(input.owner_id) : (actorId ?? null),
        input.team_id ? Number(input.team_id) : null,
        expectedValue,
        input.currency || "INR",
        probability,
        normalizeDate(input.expected_close_date),
        input.source_lead_id ? Number(input.source_lead_id) : null,
        input.notes ?? null,
        actorId ?? null,
      ],
    )
    const dealId = Number((res as any).insertId)
    await recordAudit(conn, {
      entityType: "deal",
      entityId: dealId,
      action: "create",
      summary: `Deal ${code} created in ${stage.name}`,
      actorId,
    })
    const ownerId = input.owner_id ? Number(input.owner_id) : null
    if (ownerId && ownerId !== actorId) {
      await notify(conn, {
        userId: ownerId,
        type: "info",
        title: `New deal assigned: ${title}`,
        body: `${code} · ${input.company_name || "No company"}`,
        link: "/modules/sales/deals",
        entityType: "deal",
        entityId: dealId,
      })
    }
    await conn.commit()
    return { id: dealId, deal_code: code }
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

/** Update editable deal fields with optimistic concurrency. */
export async function updateDeal(id: number, patch: Record<string, any>, actorId: Actor, expectedVersion?: number): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()
  if (expectedVersion != null && Number(expectedVersion) !== Number(current.row_version)) throw new DealConflictError()

  const fields: string[] = []
  const args: any[] = []
  const setField = (col: string, value: any) => {
    fields.push(`\`${col}\` = ?`)
    args.push(value)
  }

  if (patch.title !== undefined) {
    const t = String(patch.title || "").trim()
    if (!t) throw new DealValidationError("Deal title is required")
    setField("title", t)
  }
  if (patch.company_name !== undefined) setField("company_name", patch.company_name ?? null)
  if (patch.company_id !== undefined) setField("company_id", patch.company_id ? Number(patch.company_id) : null)
  if (patch.contact_person !== undefined) setField("contact_person", patch.contact_person ?? null)
  if (patch.owner_id !== undefined) setField("owner_id", patch.owner_id ? Number(patch.owner_id) : null)
  if (patch.team_id !== undefined) setField("team_id", patch.team_id ? Number(patch.team_id) : null)
  if (patch.expected_value !== undefined) setField("expected_value", clampMoney(patch.expected_value))
  if (patch.currency !== undefined) setField("currency", patch.currency || "INR")
  if (patch.probability !== undefined) setField("probability", patch.probability === "" || patch.probability == null ? null : clampPct(patch.probability))
  if (patch.expected_close_date !== undefined) setField("expected_close_date", normalizeDate(patch.expected_close_date))
  if (patch.notes !== undefined) setField("notes", patch.notes ?? null)

  if (fields.length === 0) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_deals SET ${fields.join(", ")}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
      [...args, id, current.row_version],
    )
    await recordAudit(conn, { entityType: "deal", entityId: id, action: "update", summary: `Deal ${current.deal_code} updated`, actorId })
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

/**
 * Move a deal to a different stage in the same pipeline. Probability follows the
 * stage default unless it was explicitly overridden. Landing on a Won/Lost stage
 * routes through win/lose so terminal state stays consistent; approval-gated
 * stages block the move until the deal is approved.
 */
export async function moveDealStage(id: number, stageId: number, actorId: Actor): Promise<{ status: DealStatus }> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()

  const stage = await getStage(stageId)
  if (!stage || stage.pipeline_id !== current.pipeline_id) throw new DealValidationError("Invalid stage for this deal's pipeline")

  if (Number(current.stage_id) === stageId) return { status: current.status }

  if (stage.requires_approval && current.approval_status !== "Approved") {
    if (current.approval_status !== "Pending") {
      await setApprovalStatus(id, "Pending", actorId, `Moved into ${stage.name} (approval required)`)
    }
  }

  if (stage.is_won) {
    await winDeal(id, { value: null, note: `Moved to ${stage.name}` }, actorId, stageId)
    return { status: "Won" }
  }
  if (stage.is_lost) {
    await loseDeal(id, { reason: current.lost_reason || "Other", note: `Moved to ${stage.name}` }, actorId, stageId)
    return { status: "Lost" }
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_deals
       SET stage_id = ?, probability = ?, status = 'Open', won_at = NULL, lost_at = NULL, row_version = row_version + 1
       WHERE id = ?`,
      [stageId, stage.probability, id],
    )
    await recordAudit(conn, {
      entityType: "deal",
      entityId: id,
      action: "stage_change",
      summary: `Deal ${current.deal_code} moved to ${stage.name}`,
      meta: { from_stage: current.stage_id, to_stage: stageId },
      actorId,
    })
    await conn.commit()
    return { status: "Open" }
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

export async function winDeal(id: number, input: { value?: number | null; note?: string | null }, actorId: Actor, stageIdOverride?: number): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()

  const wonStage = stageIdOverride
    ? await getStage(stageIdOverride)
    : (await query<PipelineStage[]>("SELECT * FROM sales_pipeline_stages WHERE pipeline_id = ? AND is_won = 1 ORDER BY sort_order ASC LIMIT 1", [current.pipeline_id]))[0]

  const stage = await getStage(Number(current.stage_id))
  if (stage?.requires_approval && current.approval_status !== "Approved") {
    throw new DealValidationError("This deal needs approval before it can be marked Won.")
  }

  const value = input.value != null ? clampMoney(input.value) : Number(current.expected_value)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_deals
       SET status = 'Won', won_at = NOW(), won_value = ?, probability = 100,
           stage_id = ?, lost_at = NULL, lost_reason = NULL, row_version = row_version + 1
       WHERE id = ?`,
      [value, wonStage ? wonStage.id : current.stage_id, id],
    )
    await recordAudit(conn, { entityType: "deal", entityId: id, action: "won", summary: `Deal ${current.deal_code} marked Won`, meta: { value }, actorId })
    if (current.owner_id && current.owner_id !== actorId) {
      await notify(conn, { userId: current.owner_id, type: "success", title: `Deal won: ${current.title}`, body: `${current.deal_code}`, link: "/modules/sales/deals", entityType: "deal", entityId: id })
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

export async function loseDeal(id: number, input: { reason: string; note?: string | null }, actorId: Actor, stageIdOverride?: number): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()

  const lostStage = stageIdOverride
    ? await getStage(stageIdOverride)
    : (await query<PipelineStage[]>("SELECT * FROM sales_pipeline_stages WHERE pipeline_id = ? AND is_lost = 1 ORDER BY sort_order ASC LIMIT 1", [current.pipeline_id]))[0]

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_deals
       SET status = 'Lost', lost_at = NOW(), lost_reason = ?, lost_notes = ?, probability = 0,
           stage_id = ?, won_at = NULL, row_version = row_version + 1
       WHERE id = ?`,
      [input.reason || "Other", input.note ?? null, lostStage ? lostStage.id : current.stage_id, id],
    )
    await recordAudit(conn, { entityType: "deal", entityId: id, action: "lost", summary: `Deal ${current.deal_code} marked Lost — ${input.reason}`, actorId })
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

export async function reopenDeal(id: number, actorId: Actor): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()
  const firstStage = (await query<PipelineStage[]>(
    "SELECT * FROM sales_pipeline_stages WHERE pipeline_id = ? AND is_won = 0 AND is_lost = 0 ORDER BY sort_order ASC LIMIT 1",
    [current.pipeline_id],
  ))[0]

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_deals
       SET status = 'Open', won_at = NULL, lost_at = NULL, lost_reason = NULL,
           stage_id = ?, probability = ?, row_version = row_version + 1
       WHERE id = ?`,
      [firstStage ? firstStage.id : current.stage_id, firstStage ? firstStage.probability : current.probability, id],
    )
    await recordAudit(conn, { entityType: "deal", entityId: id, action: "reopen", summary: `Deal ${current.deal_code} reopened`, actorId })
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Approval workflow
// ---------------------------------------------------------------------------

async function setApprovalStatus(id: number, status: ApprovalStatus, actorId: Actor, note?: string | null): Promise<void> {
  const requestedCol = status === "Pending" ? ", approval_requested_at = NOW()" : ""
  const decidedCol = status === "Approved" || status === "Rejected" ? ", approval_decided_at = NOW(), approved_by = ?" : ""
  const args: any[] = [status, note ?? null]
  if (decidedCol) args.push(actorId ?? null)
  args.push(id)
  await query(
    `UPDATE sales_deals SET approval_status = ?, approval_note = ?${requestedCol}${decidedCol}, row_version = row_version + 1 WHERE id = ?`,
    args,
  )
}

export async function requestApproval(id: number, note: string | null, actorId: Actor): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()
  await setApprovalStatus(id, "Pending", actorId, note)
  await recordAudit(null, { entityType: "deal", entityId: id, action: "approval_requested", summary: `Approval requested for ${current.deal_code}`, actorId })
}

export async function decideApproval(id: number, decision: "Approved" | "Rejected", note: string | null, actorId: Actor): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()
  await setApprovalStatus(id, decision, actorId, note)
  await recordAudit(null, { entityType: "deal", entityId: id, action: `approval_${decision.toLowerCase()}`, summary: `Deal ${current.deal_code} ${decision.toLowerCase()}`, actorId })
  if (current.owner_id && current.owner_id !== actorId) {
    await notify(null, {
      userId: current.owner_id,
      type: decision === "Approved" ? "success" : "warning",
      title: `Deal ${decision.toLowerCase()}: ${current.title}`,
      body: current.deal_code,
      link: "/modules/sales/deals",
      entityType: "deal",
      entityId: id,
    })
  }
}

export async function archiveDeal(id: number, actorId: Actor): Promise<void> {
  await ensureDealPipelineSchema()
  const current = await getDeal(id)
  if (!current) throw new DealNotFoundError()
  await query("UPDATE sales_deals SET archived_at = NOW(), row_version = row_version + 1 WHERE id = ?", [id])
  await recordAudit(null, { entityType: "deal", entityId: id, action: "delete", summary: `Deal ${current.deal_code} archived`, actorId })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampMoney(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100) / 100
}

function clampPct(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeDate(value: any): string | null {
  if (!value) return null
  const s = String(value).trim()
  if (!s) return null
  // Accept YYYY-MM-DD (and ISO) — keep only the date portion.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : null
}
