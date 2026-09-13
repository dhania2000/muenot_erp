import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { recordAudit, notify, type Actor } from "@/lib/sales/lead-lifecycle"
import { resolveCompanyId } from "@/lib/sales/company-master"
import { createMeeting } from "@/lib/sales/meeting-service"

/**
 * Central Client Onboarding lifecycle service.
 *
 * This module is the ONE place that mutates onboarding state. API routes,
 * imports, and cross-module hooks call these functions instead of writing to
 * `sales_onboarding` directly. It mirrors the "gold standard" Leads / Meetings /
 * Companies services and provides a single source of truth for:
 *   - relational linkage (company / contact / contract / quotation / lead / owner)
 *   - stage + status transitions and their rules (with explainable gating)
 *   - server-computed progress and explainable health/risk
 *   - append-only activity timeline + history
 *   - audit log + in-app notifications (shared sales infrastructure)
 *   - optimistic concurrency via row_version
 *   - soft-archive and guarded delete
 *   - lightweight owned sub-entities: checklist, tasks, milestones, documents,
 *     risks/blockers, and team members (no separate Project/Task master exists)
 *
 * Onboarding numbering continues the legacy `OB-###` sequence via the shared
 * `record_id_sequences` table, seeded from the legacy MAX so codes never collide.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const ONBOARDING_STAGES = [
  "Planning",
  "Kickoff",
  "Setup",
  "Configuration",
  "Integration",
  "Training",
  "UAT",
  "Go-Live",
  "Handover",
  "Completed",
] as const
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number]

export const ONBOARDING_STATUSES = [
  "Not Started",
  "In Progress",
  "On Hold",
  "Blocked",
  "Completed",
  "Cancelled",
] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

/** Terminal statuses cannot be transitioned out of without an explicit reopen. */
const TERMINAL_STATUSES = new Set<OnboardingStatus>(["Completed", "Cancelled"])

/** Stage index used for ordering and gate checks. */
function stageIndex(stage: string): number {
  const i = ONBOARDING_STAGES.indexOf(stage as OnboardingStage)
  return i < 0 ? 0 : i
}

/** Stage at/after which required checklist + documents must be satisfied. */
const GATE_STAGE_INDEX = ONBOARDING_STAGES.indexOf("Go-Live")

export const HEALTH_LEVELS = ["Healthy", "At Risk", "Blocked"] as const
export type HealthLevel = (typeof HEALTH_LEVELS)[number]

export const SUB_ITEM_KINDS = [
  "checklist",
  "task",
  "milestone",
  "document",
  "risk",
  "team",
] as const
export type SubItemKind = (typeof SUB_ITEM_KINDS)[number]

export class OnboardingConflictError extends Error {
  constructor(message = "This onboarding was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "OnboardingConflictError"
  }
}
export class OnboardingNotFoundError extends Error {
  constructor(message = "Onboarding record not found") {
    super(message)
    this.name = "OnboardingNotFoundError"
  }
}
export class OnboardingValidationError extends Error {
  details?: Record<string, unknown>
  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "OnboardingValidationError"
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors database/migrations/*onboarding_upgrade.sql)
// ---------------------------------------------------------------------------

let schemaEnsured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

async function addKeyIfMissing(table: string, keyName: string, ddl: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, keyName],
  )
  if (rows.length > 0) return
  await query(`ALTER TABLE \`${table}\` ADD ${ddl}`).catch(() => {})
}

const NEW_COLUMNS: [string, string][] = [
  // Relational linkage
  ["company_id", "`company_id` INT UNSIGNED DEFAULT NULL"],
  ["contact_id", "`contact_id` INT UNSIGNED DEFAULT NULL"],
  ["contract_id", "`contract_id` INT UNSIGNED DEFAULT NULL"],
  ["quotation_id", "`quotation_id` INT UNSIGNED DEFAULT NULL"],
  ["lead_id", "`lead_id` INT UNSIGNED DEFAULT NULL"],
  ["owner_id", "`owner_id` INT UNSIGNED DEFAULT NULL"],
  ["kickoff_meeting_id", "`kickoff_meeting_id` INT UNSIGNED DEFAULT NULL"],
  ["template_id", "`template_id` INT UNSIGNED DEFAULT NULL"],
  // Denormalized display fields (kept in sync from the resolved relations)
  ["contact_person", "`contact_person` VARCHAR(150) DEFAULT NULL"],
  ["contract_code", "`contract_code` VARCHAR(40) DEFAULT NULL"],
  ["currency", "`currency` VARCHAR(8) DEFAULT NULL"],
  ["contract_value", "`contract_value` DECIMAL(14,2) DEFAULT NULL"],
  // Planning + lifecycle
  ["priority", "`priority` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium'"],
  ["health", "`health` ENUM('Healthy','At Risk','Blocked') NOT NULL DEFAULT 'Healthy'"],
  ["progress_pct", "`progress_pct` TINYINT UNSIGNED NOT NULL DEFAULT 0"],
  ["target_completion_date", "`target_completion_date` DATE DEFAULT NULL"],
  ["completed_at", "`completed_at` DATETIME DEFAULT NULL"],
  ["completed_by", "`completed_by` INT UNSIGNED DEFAULT NULL"],
  ["go_live_date", "`go_live_date` DATE DEFAULT NULL"],
  ["go_live_notes", "`go_live_notes` TEXT DEFAULT NULL"],
  // Hold / block / cancel
  ["hold_reason", "`hold_reason` VARCHAR(255) DEFAULT NULL"],
  ["hold_since", "`hold_since` DATETIME DEFAULT NULL"],
  ["expected_resume_date", "`expected_resume_date` DATE DEFAULT NULL"],
  ["blocked_reason", "`blocked_reason` VARCHAR(255) DEFAULT NULL"],
  ["blocked_since", "`blocked_since` DATETIME DEFAULT NULL"],
  ["cancel_reason", "`cancel_reason` VARCHAR(255) DEFAULT NULL"],
  ["cancelled_at", "`cancelled_at` DATETIME DEFAULT NULL"],
  ["cancelled_by", "`cancelled_by` INT UNSIGNED DEFAULT NULL"],
  // Handover
  ["handover_to_id", "`handover_to_id` INT UNSIGNED DEFAULT NULL"],
  ["handover_at", "`handover_at` DATETIME DEFAULT NULL"],
  ["handover_notes", "`handover_notes` TEXT DEFAULT NULL"],
  // Notes / scope
  ["requirements_summary", "`requirements_summary` TEXT DEFAULT NULL"],
  ["scope_notes", "`scope_notes` TEXT DEFAULT NULL"],
  ["internal_notes", "`internal_notes` TEXT DEFAULT NULL"],
  ["customer_notes", "`customer_notes` TEXT DEFAULT NULL"],
  // Concurrency + soft archive
  ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
  ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
  ["created_by", "`created_by` INT UNSIGNED DEFAULT NULL"],
  ["updated_by", "`updated_by` INT UNSIGNED DEFAULT NULL"],
]

function subTableDDL(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_checklist\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`title\` VARCHAR(255) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`stage\` VARCHAR(40) DEFAULT NULL,
      \`is_required\` TINYINT(1) NOT NULL DEFAULT 0,
      \`status\` ENUM('Pending','In Progress','Done','N/A') NOT NULL DEFAULT 'Pending',
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`due_date\` DATE DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_checklist_ob\` (\`onboarding_id\`, \`sort_order\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_tasks\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`title\` VARCHAR(255) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`status\` ENUM('Open','In Progress','Done','Cancelled') NOT NULL DEFAULT 'Open',
      \`priority\` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`due_date\` DATE DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_tasks_ob\` (\`onboarding_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_milestones\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(255) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`status\` ENUM('Pending','In Progress','Done','Missed') NOT NULL DEFAULT 'Pending',
      \`due_date\` DATE DEFAULT NULL,
      \`completed_date\` DATE DEFAULT NULL,
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_milestones_ob\` (\`onboarding_id\`, \`sort_order\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_documents\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(255) NOT NULL,
      \`doc_status\` ENUM('Requested','Received','Verified','Rejected','N/A') NOT NULL DEFAULT 'Requested',
      \`is_required\` TINYINT(1) NOT NULL DEFAULT 0,
      \`file_url\` VARCHAR(500) DEFAULT NULL,
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`due_date\` DATE DEFAULT NULL,
      \`verified_by\` INT UNSIGNED DEFAULT NULL,
      \`verified_at\` DATETIME DEFAULT NULL,
      \`notes\` TEXT DEFAULT NULL,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_docs_ob\` (\`onboarding_id\`, \`doc_status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_risks\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`title\` VARCHAR(255) NOT NULL,
      \`kind\` ENUM('Risk','Blocker') NOT NULL DEFAULT 'Risk',
      \`severity\` ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
      \`status\` ENUM('Open','Mitigating','Resolved') NOT NULL DEFAULT 'Open',
      \`mitigation\` TEXT DEFAULT NULL,
      \`owner_id\` INT UNSIGNED DEFAULT NULL,
      \`due_date\` DATE DEFAULT NULL,
      \`opened_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`resolved_at\` DATETIME DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_risks_ob\` (\`onboarding_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_team\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`role\` VARCHAR(80) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_ob_team\` (\`onboarding_id\`, \`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_activities\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`activity_type\` VARCHAR(40) NOT NULL DEFAULT 'note',
      \`title\` VARCHAR(255) DEFAULT NULL,
      \`body\` TEXT DEFAULT NULL,
      \`ref_type\` VARCHAR(40) DEFAULT NULL,
      \`ref_id\` VARCHAR(64) DEFAULT NULL,
      \`occurred_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_activity\` (\`onboarding_id\`, \`occurred_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_history\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`onboarding_id\` INT UNSIGNED NOT NULL,
      \`field\` VARCHAR(40) NOT NULL,
      \`from_value\` VARCHAR(255) DEFAULT NULL,
      \`to_value\` VARCHAR(255) DEFAULT NULL,
      \`note\` VARCHAR(500) DEFAULT NULL,
      \`changed_by\` INT UNSIGNED DEFAULT NULL,
      \`changed_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ob_history\` (\`onboarding_id\`, \`changed_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sales_onboarding_templates\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(150) NOT NULL,
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`checklist\` JSON DEFAULT NULL,
      \`milestones\` JSON DEFAULT NULL,
      \`documents\` JSON DEFAULT NULL,
      \`tasks\` JSON DEFAULT NULL,
      \`version\` INT UNSIGNED NOT NULL DEFAULT 1,
      \`active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_ob_template_name\` (\`name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]
}

/**
 * Idempotently ensures every onboarding column/table exists and seeds the
 * `OB` numbering sequence from the legacy MAX so generated codes never collide
 * with pre-existing rows. Runs once per server process.
 */
export async function ensureOnboardingSchema(): Promise<void> {
  if (schemaEnsured) return
  try {
    for (const [col, ddl] of NEW_COLUMNS) await addColumnIfMissing("sales_onboarding", col, ddl)

    // Widen legacy ENUMs to the full stage/status vocabulary (keeps old values).
    await query(
      `ALTER TABLE sales_onboarding MODIFY \`current_stage\` VARCHAR(40) NOT NULL DEFAULT 'Planning'`,
    ).catch(() => {})
    await query(
      `ALTER TABLE sales_onboarding MODIFY \`status\` VARCHAR(20) NOT NULL DEFAULT 'Not Started'`,
    ).catch(() => {})

    await addKeyIfMissing("sales_onboarding", "idx_ob_company", "KEY `idx_ob_company` (`company_id`)")
    await addKeyIfMissing("sales_onboarding", "idx_ob_contract", "KEY `idx_ob_contract` (`contract_id`)")
    await addKeyIfMissing("sales_onboarding", "idx_ob_status", "KEY `idx_ob_status` (`status`)")
    await addKeyIfMissing("sales_onboarding", "idx_ob_owner", "KEY `idx_ob_owner` (`owner_id`)")
    await addKeyIfMissing("sales_onboarding", "idx_ob_archived", "KEY `idx_ob_archived` (`archived_at`)")

    for (const ddl of subTableDDL()) await query(ddl).catch(() => {})

    // Link column on meetings so a kickoff can be traced back to onboarding.
    await addColumnIfMissing("sales_meetings", "onboarding_id", "`onboarding_id` INT UNSIGNED DEFAULT NULL")

    await seedNumberingSequence()
    await seedDefaultTemplates()
    schemaEnsured = true
  } catch (e) {
    console.error("[onboarding] ensureOnboardingSchema failed", e)
  }
}

/**
 * Seed the shared `OB` counter from the highest existing `OB-###` suffix so the
 * first generated code is (legacy MAX + 1). GREATEST keeps an already-higher
 * counter intact, making this safe to run repeatedly and race-free.
 */
async function seedNumberingSequence(): Promise<void> {
  await query(
    `INSERT INTO record_id_sequences (prefix, next_number)
     SELECT 'OB', COALESCE(MAX(CAST(REGEXP_REPLACE(onboarding_code, '^[^0-9]*', '') AS UNSIGNED)), 0)
     FROM sales_onboarding
     WHERE onboarding_code REGEXP '^OB-?[0-9]+$'
     ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number))`,
  ).catch((e) => console.error("[onboarding] seed numbering failed", e))
}

let templatesSeeded = false
async function seedDefaultTemplates(): Promise<void> {
  if (templatesSeeded) return
  templatesSeeded = true
  const rows = await query<any[]>(`SELECT COUNT(*) AS c FROM sales_onboarding_templates`).catch(() => [{ c: 1 }])
  if (Number(rows?.[0]?.c || 0) > 0) return
  const standard = {
    name: "Standard Implementation",
    description: "Default onboarding playbook for new client implementations.",
    checklist: [
      { title: "Signed contract received", stage: "Planning", is_required: 1 },
      { title: "Kickoff meeting scheduled", stage: "Kickoff", is_required: 1 },
      { title: "Requirements gathered", stage: "Setup", is_required: 1 },
      { title: "Environment provisioned", stage: "Configuration", is_required: 1 },
      { title: "Data migration complete", stage: "Integration", is_required: 0 },
      { title: "User training delivered", stage: "Training", is_required: 1 },
      { title: "UAT sign-off", stage: "UAT", is_required: 1 },
      { title: "Go-live checklist confirmed", stage: "Go-Live", is_required: 1 },
    ],
    milestones: [
      { name: "Kickoff complete" },
      { name: "Configuration complete" },
      { name: "Go-live" },
    ],
    documents: [
      { name: "Signed contract", is_required: 1 },
      { name: "Requirements document", is_required: 1 },
      { name: "UAT sign-off", is_required: 1 },
    ],
    tasks: [],
  }
  await query(
    `INSERT IGNORE INTO sales_onboarding_templates (name, description, checklist, milestones, documents, tasks)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      standard.name,
      standard.description,
      JSON.stringify(standard.checklist),
      JSON.stringify(standard.milestones),
      JSON.stringify(standard.documents),
      JSON.stringify(standard.tasks),
    ],
  ).catch((e) => console.error("[onboarding] seed templates failed", e))
}

async function nextOnboardingCode(): Promise<string> {
  // Legacy codes use the `OB-###` format with 3 digits; continue it exactly.
  return nextRecordId("OB", { digits: 3, allowCustom: true })
}

// ---------------------------------------------------------------------------
// Relationship resolution + consistency validation
// ---------------------------------------------------------------------------

export type OnboardingRelationInput = {
  company_id?: number | string | null
  company_name?: string | null
  contact_id?: number | string | null
  contact_person?: string | null
  contract_id?: number | string | null
  contract_code?: string | null
  quotation_id?: number | string | null
  lead_id?: number | string | null
  owner_id?: number | string | null
}

type ResolvedRelations = {
  companyId: number | null
  companyName: string | null
  contactId: number | null
  contactPerson: string | null
  contractId: number | null
  contractCode: string | null
  contractValue: number | null
  currency: string | null
  quotationId: number | null
  leadId: number | null
  ownerId: number | null
}

function toId(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Resolve and validate the relational graph. Guarantees that a linked contact
 * belongs to the linked company and that a linked contract belongs to the same
 * company, so a record cannot point at inconsistent parents.
 */
async function resolveRelationships(
  input: OnboardingRelationInput,
  conn?: PoolConnection,
): Promise<ResolvedRelations> {
  const q = <T = any[]>(sql: string, params: any[]) =>
    (conn ? conn.query(sql, params).then(([r]: any) => r as T) : query<T>(sql, params))

  let companyId = toId(input.company_id)
  if (!companyId && input.company_name) {
    companyId = await resolveCompanyId({ company_name: input.company_name })
  }
  let companyName = input.company_name ? String(input.company_name).trim() : null

  // Resolve contract first — it can imply the company / quotation.
  let contractId = toId(input.contract_id)
  let contractCode: string | null = input.contract_code ? String(input.contract_code).trim() : null
  let contractValue: number | null = null
  let currency: string | null = null
  let quotationId = toId(input.quotation_id)

  if (!contractId && contractCode) {
    const rows = await q<any[]>(`SELECT id FROM sales_contracts WHERE contract_code = ? LIMIT 1`, [contractCode])
    if (rows[0]) contractId = Number(rows[0].id)
  }
  if (contractId) {
    const rows = await q<any[]>(`SELECT * FROM sales_contracts WHERE id = ? LIMIT 1`, [contractId])
    const c = rows[0]
    if (!c) throw new OnboardingValidationError("Linked contract does not exist")
    contractCode = c.contract_code ?? contractCode
    contractValue = c.value != null ? Number(c.value) : null
    if (c.company_id) {
      if (companyId && Number(companyId) !== Number(c.company_id)) {
        throw new OnboardingValidationError("Selected contract belongs to a different company")
      }
      companyId = Number(c.company_id)
    }
    if (!companyName && c.company_name) companyName = c.company_name
    if (!quotationId && c.source_quotation_id) quotationId = Number(c.source_quotation_id)
  }

  // Company display name + currency default
  if (companyId) {
    const rows = await q<any[]>(`SELECT company_name, currency FROM sales_companies WHERE id = ? LIMIT 1`, [companyId])
    if (rows[0]) {
      companyName = rows[0].company_name ?? companyName
      currency = rows[0].currency ?? currency
    }
  }

  // Contact must belong to the resolved company.
  let contactId = toId(input.contact_id)
  let contactPerson = input.contact_person ? String(input.contact_person).trim() : null
  if (contactId) {
    const rows = await q<any[]>(`SELECT id, company_id, name FROM sales_contacts WHERE id = ? LIMIT 1`, [contactId])
    const ct = rows[0]
    if (!ct) throw new OnboardingValidationError("Linked contact does not exist")
    if (companyId && ct.company_id && Number(ct.company_id) !== Number(companyId)) {
      throw new OnboardingValidationError("Selected contact belongs to a different company")
    }
    contactPerson = ct.name ?? contactPerson
  }

  // Quotation consistency (best-effort; quotation may predate company_id).
  if (quotationId) {
    const rows = await q<any[]>(`SELECT id, company_id FROM sales_quotations WHERE id = ? LIMIT 1`, [quotationId])
    const qr = rows[0]
    if (!qr) throw new OnboardingValidationError("Linked quotation does not exist")
    if (companyId && qr.company_id && Number(qr.company_id) !== Number(companyId)) {
      throw new OnboardingValidationError("Selected quotation belongs to a different company")
    }
  }

  const leadId = toId(input.lead_id)
  if (leadId) {
    const rows = await q<any[]>(`SELECT id, company_id FROM sales_leads WHERE id = ? LIMIT 1`, [leadId])
    if (!rows[0]) throw new OnboardingValidationError("Linked lead does not exist")
  }

  return {
    companyId,
    companyName,
    contactId,
    contactPerson,
    contractId,
    contractCode,
    contractValue,
    currency,
    quotationId,
    leadId,
    ownerId: toId(input.owner_id),
  }
}

// ---------------------------------------------------------------------------
// Progress + health computation (server-side, explainable)
// ---------------------------------------------------------------------------

type SubItems = {
  checklist: any[]
  tasks: any[]
  milestones: any[]
  documents: any[]
  risks: any[]
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function isOverdue(date: unknown): boolean {
  if (!date) return false
  const d = String(date).slice(0, 10)
  return d < todayISO()
}

/**
 * Progress is driven by completed required checklist items. When a record has
 * no required checklist, it falls back to the stage position so a bare record
 * still reports meaningful progress.
 */
export function computeProgress(record: any, items: SubItems): number {
  const required = items.checklist.filter((c) => c.is_required && c.status !== "N/A")
  if (required.length > 0) {
    const done = required.filter((c) => c.status === "Done").length
    return Math.round((done / required.length) * 100)
  }
  const anyChecklist = items.checklist.filter((c) => c.status !== "N/A")
  if (anyChecklist.length > 0) {
    const done = anyChecklist.filter((c) => c.status === "Done").length
    return Math.round((done / anyChecklist.length) * 100)
  }
  if (record.status === "Completed") return 100
  return Math.round((stageIndex(record.current_stage) / (ONBOARDING_STAGES.length - 1)) * 100)
}

export type HealthAssessment = { level: HealthLevel; reasons: string[] }

/** Explainable health: returns the level plus the specific reasons behind it. */
export function computeHealth(record: any, items: SubItems): HealthAssessment {
  const reasons: string[] = []
  if (record.status === "Completed") return { level: "Healthy", reasons: ["Onboarding completed"] }
  if (record.status === "Cancelled") return { level: "Healthy", reasons: ["Onboarding cancelled"] }

  let blocked = false
  let atRisk = false

  if (record.status === "Blocked") {
    blocked = true
    reasons.push(record.blocked_reason ? `Blocked: ${record.blocked_reason}` : "Status is Blocked")
  }
  const openBlockers = items.risks.filter((r) => r.kind === "Blocker" && r.status !== "Resolved")
  if (openBlockers.length) {
    blocked = true
    reasons.push(`${openBlockers.length} open blocker${openBlockers.length > 1 ? "s" : ""}`)
  }
  const criticalRisks = items.risks.filter(
    (r) => r.status !== "Resolved" && (r.severity === "Critical" || r.severity === "High"),
  )
  if (criticalRisks.length) {
    atRisk = true
    reasons.push(`${criticalRisks.length} high/critical risk${criticalRisks.length > 1 ? "s" : ""} open`)
  }

  if (record.status === "On Hold") {
    atRisk = true
    reasons.push(record.hold_reason ? `On hold: ${record.hold_reason}` : "On hold")
  }
  if (isOverdue(record.target_completion_date) && record.status !== "Completed") {
    atRisk = true
    reasons.push("Past target completion date")
  }
  const overdueTasks = items.tasks.filter((t) => t.status !== "Done" && t.status !== "Cancelled" && isOverdue(t.due_date))
  if (overdueTasks.length) {
    atRisk = true
    reasons.push(`${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`)
  }
  const overdueDocs = items.documents.filter(
    (d) => d.is_required && !["Verified", "Received", "N/A"].includes(d.doc_status) && isOverdue(d.due_date),
  )
  if (overdueDocs.length) {
    atRisk = true
    reasons.push(`${overdueDocs.length} overdue required document${overdueDocs.length > 1 ? "s" : ""}`)
  }
  const missedMilestones = items.milestones.filter(
    (m) => m.status !== "Done" && isOverdue(m.due_date),
  )
  if (missedMilestones.length) {
    atRisk = true
    reasons.push(`${missedMilestones.length} missed milestone${missedMilestones.length > 1 ? "s" : ""}`)
  }

  if (blocked) return { level: "Blocked", reasons }
  if (atRisk) return { level: "At Risk", reasons }
  return { level: "Healthy", reasons: ["On track"] }
}

// ---------------------------------------------------------------------------
// Shared write primitives
// ---------------------------------------------------------------------------

async function run<T = any>(conn: PoolConnection | null, sql: string, params: any[] = []): Promise<T> {
  if (conn) {
    const [rows] = await conn.query(sql, params)
    return rows as T
  }
  return query<T>(sql, params)
}

async function logActivity(
  conn: PoolConnection | null,
  input: {
    onboardingId: number
    type: string
    title?: string | null
    body?: string | null
    refType?: string | null
    refId?: string | number | null
    createdBy?: Actor
  },
): Promise<void> {
  await run(
    conn,
    `INSERT INTO sales_onboarding_activities (onboarding_id, activity_type, title, body, ref_type, ref_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.onboardingId,
      input.type,
      input.title ?? null,
      input.body ?? null,
      input.refType ?? null,
      input.refId != null ? String(input.refId) : null,
      input.createdBy ?? null,
    ],
  ).catch((e) => console.error("[onboarding] activity insert failed", e))
}

async function logHistory(
  conn: PoolConnection | null,
  input: {
    onboardingId: number
    field: string
    from?: unknown
    to?: unknown
    note?: string | null
    changedBy?: Actor
  },
): Promise<void> {
  await run(
    conn,
    `INSERT INTO sales_onboarding_history (onboarding_id, field, from_value, to_value, note, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.onboardingId,
      input.field,
      input.from != null ? String(input.from) : null,
      input.to != null ? String(input.to) : null,
      input.note ?? null,
      input.changedBy ?? null,
    ],
  ).catch((e) => console.error("[onboarding] history insert failed", e))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIST_SELECT = `
  SELECT o.*, 
    owner.name AS owner_name,
    creator.name AS added_by_name,
    co.company_name AS company_name_rel
  FROM sales_onboarding o
  LEFT JOIN users owner ON owner.id = o.owner_id
  LEFT JOIN users creator ON creator.id = o.added_by
  LEFT JOIN sales_companies co ON co.id = o.company_id
`

async function loadSubItems(onboardingId: number, conn?: PoolConnection): Promise<SubItems> {
  const q = <T = any[]>(sql: string, params: any[]) =>
    (conn ? conn.query(sql, params).then(([r]: any) => r as T) : query<T>(sql, params))
  const [checklist, tasks, milestones, documents, risks] = await Promise.all([
    q<any[]>(`SELECT * FROM sales_onboarding_checklist WHERE onboarding_id = ? ORDER BY sort_order, id`, [onboardingId]),
    q<any[]>(`SELECT * FROM sales_onboarding_tasks WHERE onboarding_id = ? ORDER BY sort_order, id`, [onboardingId]),
    q<any[]>(`SELECT * FROM sales_onboarding_milestones WHERE onboarding_id = ? ORDER BY sort_order, id`, [onboardingId]),
    q<any[]>(`SELECT * FROM sales_onboarding_documents WHERE onboarding_id = ? ORDER BY sort_order, id`, [onboardingId]),
    q<any[]>(`SELECT * FROM sales_onboarding_risks WHERE onboarding_id = ? ORDER BY opened_at DESC, id`, [onboardingId]),
  ])
  return { checklist, tasks, milestones, documents, risks }
}

export async function listOnboarding(filters: {
  search?: string
  status?: string
  stage?: string
  health?: string
  ownerId?: number
  companyId?: number
  includeArchived?: boolean
} = {}): Promise<any[]> {
  await ensureOnboardingSchema()
  const where: string[] = []
  const params: any[] = []
  if (!filters.includeArchived) where.push("o.archived_at IS NULL")
  if (filters.status) {
    where.push("o.status = ?")
    params.push(filters.status)
  }
  if (filters.stage) {
    where.push("o.current_stage = ?")
    params.push(filters.stage)
  }
  if (filters.health) {
    where.push("o.health = ?")
    params.push(filters.health)
  }
  if (filters.ownerId) {
    where.push("o.owner_id = ?")
    params.push(filters.ownerId)
  }
  if (filters.companyId) {
    where.push("o.company_id = ?")
    params.push(filters.companyId)
  }
  if (filters.search) {
    where.push("(o.company_name LIKE ? OR o.onboarding_code LIKE ? OR o.contract_code LIKE ? OR o.contact_person LIKE ?)")
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }
  const sql = `${LIST_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.created_at DESC`
  const rows = await query<any[]>(sql, params)
  return rows.map((r) => ({ ...r, company_name: r.company_name || r.company_name_rel }))
}

export async function getOnboarding(id: number): Promise<any | null> {
  await ensureOnboardingSchema()
  const rows = await query<any[]>(
    `${LIST_SELECT}
     WHERE o.id = ? LIMIT 1`,
    [id],
  )
  const record = rows[0]
  if (!record) return null
  record.company_name = record.company_name || record.company_name_rel
  return record
}

/** Full detail view: record + resolved relations + sub-items + timeline + health. */
export async function getOnboardingDetail(id: number): Promise<any | null> {
  const record = await getOnboarding(id)
  if (!record) return null
  const items = await loadSubItems(id)
  const [activities, history, contract, quotation, lead, kickoff, team] = await Promise.all([
    query<any[]>(
      `SELECT a.*, u.name AS actor_name FROM sales_onboarding_activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.onboarding_id = ? ORDER BY a.occurred_at DESC, a.id DESC LIMIT 200`,
      [id],
    ),
    query<any[]>(
      `SELECT h.*, u.name AS actor_name FROM sales_onboarding_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.onboarding_id = ? ORDER BY h.changed_at DESC, h.id DESC LIMIT 200`,
      [id],
    ),
    record.contract_id
      ? query<any[]>(`SELECT id, contract_code, status, value, start_date, end_date FROM sales_contracts WHERE id = ? LIMIT 1`, [record.contract_id]).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    record.quotation_id
      ? query<any[]>(`SELECT id, quote_code, total_amount, status FROM sales_quotations WHERE id = ? LIMIT 1`, [record.quotation_id]).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    record.lead_id
      ? query<any[]>(`SELECT id, lead_code, company_name, status FROM sales_leads WHERE id = ? LIMIT 1`, [record.lead_id]).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    record.kickoff_meeting_id
      ? query<any[]>(`SELECT id, meeting_code, meeting_date, meeting_time, meeting_type FROM sales_meetings WHERE id = ? LIMIT 1`, [record.kickoff_meeting_id]).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    query<any[]>(
      `SELECT t.*, u.name AS user_name FROM sales_onboarding_team t
       LEFT JOIN users u ON u.id = t.user_id WHERE t.onboarding_id = ? ORDER BY t.id`,
      [id],
    ),
  ])
  const health = computeHealth(record, items)
  const progress = computeProgress(record, items)
  return {
    ...record,
    progress_pct: progress,
    health: health.level,
    health_reasons: health.reasons,
    items,
    team,
    activities,
    history,
    relations: { contract, quotation, lead, kickoff },
  }
}

/** Recompute cached progress + health and persist them (kept outside txns). */
export async function recomputeAndCache(onboardingId: number): Promise<{ progress: number; health: HealthLevel }> {
  const record = await getOnboarding(onboardingId)
  if (!record) return { progress: 0, health: "Healthy" }
  const items = await loadSubItems(onboardingId)
  const progress = computeProgress(record, items)
  const health = computeHealth(record, items).level
  await query(`UPDATE sales_onboarding SET progress_pct = ?, health = ? WHERE id = ?`, [progress, health, onboardingId]).catch(
    () => {},
  )
  return { progress, health }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type OnboardingCreateInput = OnboardingRelationInput & {
  onboarding_date?: string | null
  start_date?: string | null
  target_completion_date?: string | null
  kickoff_meeting_date?: string | null
  priority?: string | null
  current_stage?: string | null
  status?: string | null
  requirements_summary?: string | null
  scope_notes?: string | null
  internal_notes?: string | null
  template_id?: number | null
}

/** Ensures at most one active (non-terminal, non-archived) onboarding per contract. */
async function assertNoActiveForContract(contractId: number | null, conn: PoolConnection, excludeId?: number) {
  if (!contractId) return
  const [rows] = await conn.query<any[]>(
    `SELECT id, onboarding_code FROM sales_onboarding
     WHERE contract_id = ? AND archived_at IS NULL AND status NOT IN ('Completed','Cancelled')
     ${excludeId ? "AND id <> ?" : ""} LIMIT 1`,
    excludeId ? [contractId, excludeId] : [contractId],
  )
  if (rows[0]) {
    throw new OnboardingValidationError(
      `An active onboarding already exists for this contract (${rows[0].onboarding_code}).`,
      { existingId: rows[0].id, existingCode: rows[0].onboarding_code },
    )
  }
}

export async function createOnboarding(input: OnboardingCreateInput, actorId: Actor): Promise<any> {
  await ensureOnboardingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const rel = await resolveRelationships(input, conn)
    await assertNoActiveForContract(rel.contractId, conn)

    if (!rel.companyId && !rel.companyName) {
      throw new OnboardingValidationError("A company is required to start onboarding")
    }

    const code = await nextOnboardingCode()
    const stage = (input.current_stage as OnboardingStage) || "Planning"
    const status = (input.status as OnboardingStatus) || "Not Started"

    const [result] = await conn.query<any>(
      `INSERT INTO sales_onboarding
        (onboarding_code, onboarding_date, company_id, company_name, contact_id, contact_person,
         contract_id, contract_code, contract_value, currency, quotation_id, lead_id, owner_id,
         start_date, target_completion_date, kickoff_meeting_date, priority, current_stage, status,
         requirements_summary, scope_notes, internal_notes, template_id, onboarding_by,
         added_by, created_by, row_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        code,
        input.onboarding_date || todayISO(),
        rel.companyId,
        rel.companyName,
        rel.contactId,
        rel.contactPerson,
        rel.contractId,
        rel.contractCode,
        rel.contractValue,
        rel.currency,
        rel.quotationId,
        rel.leadId,
        rel.ownerId,
        input.start_date || null,
        input.target_completion_date || null,
        input.kickoff_meeting_date || null,
        input.priority || "Medium",
        stage,
        status,
        input.requirements_summary || null,
        input.scope_notes || null,
        input.internal_notes || null,
        input.template_id || null,
        null,
        actorId ?? null,
        actorId ?? null,
      ],
    )
    const id = Number(result.insertId)

    if (input.template_id) await applyTemplateItems(conn, id, Number(input.template_id), actorId)

    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "create",
      summary: `Onboarding ${code} created${rel.companyName ? ` for ${rel.companyName}` : ""}`,
      meta: { onboarding_code: code, contract_code: rel.contractCode },
      actorId,
    })
    await logActivity(conn, { onboardingId: id, type: "created", title: `Onboarding ${code} created`, createdBy: actorId })
    if (rel.ownerId) {
      await notify(conn, {
        userId: rel.ownerId,
        type: "onboarding_assigned",
        title: `You own onboarding ${code}`,
        body: rel.companyName || undefined,
        link: `/modules/sales/onboarding`,
        entityType: "onboarding",
        entityId: id,
      })
    }
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Create onboarding directly from a signed contract (idempotent per contract). */
export async function createFromContract(contractId: number, actorId: Actor): Promise<any> {
  await ensureOnboardingSchema()
  const rows = await query<any[]>(`SELECT * FROM sales_contracts WHERE id = ? LIMIT 1`, [contractId])
  const contract = rows[0]
  if (!contract) throw new OnboardingValidationError("Contract not found")
  return createOnboarding(
    {
      contract_id: contractId,
      company_id: contract.company_id,
      company_name: contract.company_name,
      owner_id: contract.added_by,
      start_date: contract.start_date,
      template_id: undefined,
      current_stage: "Planning",
      status: "Not Started",
    },
    actorId,
  )
}

async function applyTemplateItems(conn: PoolConnection, onboardingId: number, templateId: number, actorId: Actor) {
  const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding_templates WHERE id = ? LIMIT 1`, [templateId])
  const tpl = rows[0]
  if (!tpl) return
  const parse = (v: any) => {
    if (!v) return []
    if (typeof v === "string") {
      try {
        return JSON.parse(v)
      } catch {
        return []
      }
    }
    return Array.isArray(v) ? v : []
  }
  const checklist = parse(tpl.checklist)
  const milestones = parse(tpl.milestones)
  const documents = parse(tpl.documents)
  const tasks = parse(tpl.tasks)
  let order = 0
  for (const c of checklist) {
    await conn.query(
      `INSERT INTO sales_onboarding_checklist (onboarding_id, title, stage, is_required, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [onboardingId, c.title, c.stage || null, c.is_required ? 1 : 0, order++, actorId ?? null],
    )
  }
  order = 0
  for (const m of milestones) {
    await conn.query(
      `INSERT INTO sales_onboarding_milestones (onboarding_id, name, sort_order, created_by) VALUES (?, ?, ?, ?)`,
      [onboardingId, m.name, order++, actorId ?? null],
    )
  }
  order = 0
  for (const d of documents) {
    await conn.query(
      `INSERT INTO sales_onboarding_documents (onboarding_id, name, is_required, sort_order, created_by) VALUES (?, ?, ?, ?, ?)`,
      [onboardingId, d.name, d.is_required ? 1 : 0, order++, actorId ?? null],
    )
  }
  order = 0
  for (const t of tasks) {
    await conn.query(
      `INSERT INTO sales_onboarding_tasks (onboarding_id, title, sort_order, created_by) VALUES (?, ?, ?, ?)`,
      [onboardingId, t.title, order++, actorId ?? null],
    )
  }
}

// ---------------------------------------------------------------------------
// Update (optimistic concurrency; never re-creates)
// ---------------------------------------------------------------------------

export async function updateOnboarding(
  id: number,
  input: Partial<OnboardingCreateInput> & { expectedRowVersion?: number },
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (input.expectedRowVersion != null && Number(input.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }

    const rel = await resolveRelationships(
      {
        company_id: input.company_id ?? current.company_id,
        company_name: input.company_name ?? current.company_name,
        contact_id: input.contact_id ?? current.contact_id,
        contact_person: input.contact_person ?? current.contact_person,
        contract_id: input.contract_id ?? current.contract_id,
        contract_code: input.contract_code ?? current.contract_code,
        quotation_id: input.quotation_id ?? current.quotation_id,
        lead_id: input.lead_id ?? current.lead_id,
        owner_id: input.owner_id ?? current.owner_id,
      },
      conn,
    )
    if (rel.contractId && rel.contractId !== current.contract_id) {
      await assertNoActiveForContract(rel.contractId, conn, id)
    }

    await conn.query(
      `UPDATE sales_onboarding SET
        onboarding_date = ?, company_id = ?, company_name = ?, contact_id = ?, contact_person = ?,
        contract_id = ?, contract_code = ?, contract_value = ?, currency = ?, quotation_id = ?, lead_id = ?,
        owner_id = ?, start_date = ?, target_completion_date = ?, kickoff_meeting_date = ?, priority = ?,
        requirements_summary = ?, scope_notes = ?, internal_notes = ?, customer_notes = ?,
        updated_by = ?, row_version = row_version + 1
       WHERE id = ?`,
      [
        input.onboarding_date ?? current.onboarding_date,
        rel.companyId,
        rel.companyName,
        rel.contactId,
        rel.contactPerson,
        rel.contractId,
        rel.contractCode,
        rel.contractValue ?? current.contract_value,
        rel.currency ?? current.currency,
        rel.quotationId,
        rel.leadId,
        rel.ownerId,
        input.start_date !== undefined ? input.start_date : current.start_date,
        input.target_completion_date !== undefined ? input.target_completion_date : current.target_completion_date,
        input.kickoff_meeting_date !== undefined ? input.kickoff_meeting_date : current.kickoff_meeting_date,
        input.priority ?? current.priority,
        input.requirements_summary !== undefined ? input.requirements_summary : current.requirements_summary,
        input.scope_notes !== undefined ? input.scope_notes : current.scope_notes,
        input.internal_notes !== undefined ? input.internal_notes : current.internal_notes,
        (input as any).customer_notes !== undefined ? (input as any).customer_notes : current.customer_notes,
        actorId ?? null,
        id,
      ],
    )

    if (input.owner_id !== undefined && Number(input.owner_id) !== Number(current.owner_id)) {
      await logHistory(conn, { onboardingId: id, field: "owner", from: current.owner_id, to: rel.ownerId, changedBy: actorId })
      if (rel.ownerId) {
        await notify(conn, {
          userId: rel.ownerId,
          type: "onboarding_assigned",
          title: `You now own onboarding ${current.onboarding_code}`,
          link: `/modules/sales/onboarding`,
          entityType: "onboarding",
          entityId: id,
        })
      }
    }

    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "update",
      summary: `Onboarding ${current.onboarding_code} updated`,
      actorId,
    })
    await logActivity(conn, { onboardingId: id, type: "update", title: "Details updated", createdBy: actorId })
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Change the active stage, gating Go-Live+ on required checklist / documents. */
export async function changeStage(
  id: number,
  toStage: OnboardingStage,
  opts: { override?: boolean; reason?: string; expectedRowVersion?: number },
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  if (!ONBOARDING_STAGES.includes(toStage)) throw new OnboardingValidationError("Unknown stage")
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (opts.expectedRowVersion != null && Number(opts.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new OnboardingValidationError(`Cannot change stage while ${current.status}. Reopen first.`)
    }
    const from = current.current_stage

    // Gate: entering Go-Live or later requires required checklist + docs satisfied.
    if (stageIndex(toStage) >= GATE_STAGE_INDEX && !opts.override) {
      const items = await loadSubItems(id, conn)
      const pendingChecklist = items.checklist.filter((c) => c.is_required && c.status !== "Done" && c.status !== "N/A")
      const pendingDocs = items.documents.filter(
        (d) => d.is_required && !["Verified", "N/A"].includes(d.doc_status),
      )
      if (pendingChecklist.length || pendingDocs.length) {
        throw new OnboardingValidationError(
          `Cannot advance to ${toStage}: ${pendingChecklist.length} required checklist item(s) and ${pendingDocs.length} required document(s) outstanding. Override to force.`,
          { pendingChecklist: pendingChecklist.length, pendingDocs: pendingDocs.length, requiresOverride: true },
        )
      }
    }

    const nextStatus = current.status === "Not Started" ? "In Progress" : current.status
    await conn.query(
      `UPDATE sales_onboarding SET current_stage = ?, status = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [toStage, nextStatus, actorId ?? null, id],
    )
    await logHistory(conn, {
      onboardingId: id,
      field: "stage",
      from,
      to: toStage,
      note: opts.override ? `Override: ${opts.reason || "forced"}` : opts.reason || null,
      changedBy: actorId,
    })
    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "stage_change",
      summary: `Stage ${from} → ${toStage}${opts.override ? " (override)" : ""}`,
      meta: { from, to: toStage, override: !!opts.override },
      actorId,
    })
    await logActivity(conn, {
      onboardingId: id,
      type: "stage",
      title: `Stage → ${toStage}`,
      body: opts.reason || null,
      createdBy: actorId,
    })
    if (current.owner_id) {
      await notify(conn, {
        userId: current.owner_id,
        type: "onboarding_stage",
        title: `${current.onboarding_code}: ${toStage}`,
        body: `${from} → ${toStage}`,
        link: `/modules/sales/onboarding`,
        entityType: "onboarding",
        entityId: id,
      })
    }
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

type StatusChangeOpts = {
  reason?: string
  expected_resume_date?: string | null
  expectedRowVersion?: number
  override?: boolean
}

/** Unified status transition (hold / block / resume / cancel / reopen / complete). */
export async function changeStatus(
  id: number,
  toStatus: OnboardingStatus,
  opts: StatusChangeOpts,
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  if (!ONBOARDING_STATUSES.includes(toStatus)) throw new OnboardingValidationError("Unknown status")

  if (toStatus === "Completed") return completeOnboarding(id, opts, actorId)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (opts.expectedRowVersion != null && Number(opts.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }
    const from = current.status
    if (from === toStatus) return await getOnboarding(id)

    if ((toStatus === "On Hold" || toStatus === "Blocked" || toStatus === "Cancelled") && !opts.reason) {
      throw new OnboardingValidationError(`A reason is required to mark this onboarding ${toStatus}.`)
    }

    const sets: string[] = ["status = ?", "row_version = row_version + 1", "updated_by = ?"]
    const params: any[] = [toStatus, actorId ?? null]

    if (toStatus === "On Hold") {
      sets.push("hold_reason = ?", "hold_since = NOW()", "expected_resume_date = ?")
      params.push(opts.reason || null, opts.expected_resume_date || null)
    } else if (toStatus === "Blocked") {
      sets.push("blocked_reason = ?", "blocked_since = NOW()")
      params.push(opts.reason || null)
    } else if (toStatus === "Cancelled") {
      sets.push("cancel_reason = ?", "cancelled_at = NOW()", "cancelled_by = ?")
      params.push(opts.reason || null, actorId ?? null)
    } else if (toStatus === "In Progress") {
      // Resuming clears hold/block markers.
      sets.push("hold_reason = NULL", "hold_since = NULL", "expected_resume_date = NULL", "blocked_reason = NULL", "blocked_since = NULL")
    }

    await conn.query(`UPDATE sales_onboarding SET ${sets.join(", ")} WHERE id = ?`, [...params, id])

    await logHistory(conn, { onboardingId: id, field: "status", from, to: toStatus, note: opts.reason || null, changedBy: actorId })
    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "status_change",
      summary: `Status ${from} → ${toStatus}`,
      meta: { from, to: toStatus, reason: opts.reason },
      actorId,
    })
    await logActivity(conn, {
      onboardingId: id,
      type: "status",
      title: `Status → ${toStatus}`,
      body: opts.reason || null,
      createdBy: actorId,
    })
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Completion validates required checklist/documents unless overridden. */
export async function completeOnboarding(id: number, opts: StatusChangeOpts, actorId: Actor): Promise<any> {
  await ensureOnboardingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (opts.expectedRowVersion != null && Number(opts.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }
    const items = await loadSubItems(id, conn)
    if (!opts.override) {
      const pendingChecklist = items.checklist.filter((c) => c.is_required && c.status !== "Done" && c.status !== "N/A")
      const pendingDocs = items.documents.filter((d) => d.is_required && !["Verified", "N/A"].includes(d.doc_status))
      const openBlockers = items.risks.filter((r) => r.kind === "Blocker" && r.status !== "Resolved")
      if (pendingChecklist.length || pendingDocs.length || openBlockers.length) {
        throw new OnboardingValidationError(
          `Cannot complete: ${pendingChecklist.length} required checklist item(s), ${pendingDocs.length} required document(s), and ${openBlockers.length} open blocker(s) remain. Override to force.`,
          {
            pendingChecklist: pendingChecklist.length,
            pendingDocs: pendingDocs.length,
            openBlockers: openBlockers.length,
            requiresOverride: true,
          },
        )
      }
    }
    const from = current.status
    await conn.query(
      `UPDATE sales_onboarding SET status = 'Completed', current_stage = 'Completed', progress_pct = 100, health = 'Healthy',
        completed_at = NOW(), completed_by = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [actorId ?? null, actorId ?? null, id],
    )
    await logHistory(conn, {
      onboardingId: id,
      field: "status",
      from,
      to: "Completed",
      note: opts.override ? `Override: ${opts.reason || "forced"}` : opts.reason || null,
      changedBy: actorId,
    })
    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "complete",
      summary: `Onboarding ${current.onboarding_code} completed${opts.override ? " (override)" : ""}`,
      actorId,
    })
    await logActivity(conn, { onboardingId: id, type: "complete", title: "Onboarding completed", createdBy: actorId })
    if (current.owner_id) {
      await notify(conn, {
        userId: current.owner_id,
        type: "onboarding_completed",
        title: `${current.onboarding_code} completed`,
        body: current.company_name || undefined,
        link: `/modules/sales/onboarding`,
        entityType: "onboarding",
        entityId: id,
      })
    }
    await conn.commit()
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Reopen a completed / cancelled onboarding back into progress. */
export async function reopenOnboarding(id: number, opts: StatusChangeOpts, actorId: Actor): Promise<any> {
  await ensureOnboardingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (!TERMINAL_STATUSES.has(current.status)) {
      throw new OnboardingValidationError("Only completed or cancelled onboarding can be reopened.")
    }
    await conn.query(
      `UPDATE sales_onboarding SET status = 'In Progress', completed_at = NULL, completed_by = NULL,
        cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [actorId ?? null, id],
    )
    await logHistory(conn, { onboardingId: id, field: "status", from: current.status, to: "In Progress", note: opts.reason || "Reopened", changedBy: actorId })
    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "reopen",
      summary: `Onboarding ${current.onboarding_code} reopened`,
      actorId,
    })
    await logActivity(conn, { onboardingId: id, type: "status", title: "Reopened", body: opts.reason || null, createdBy: actorId })
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Record a handover to another owner and (optionally) reassign ownership. */
export async function handoverOnboarding(
  id: number,
  input: { handover_to_id: number; notes?: string | null; reassign?: boolean; expectedRowVersion?: number },
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const toId = Number(input.handover_to_id)
  if (!toId) throw new OnboardingValidationError("A handover recipient is required")
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (input.expectedRowVersion != null && Number(input.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }
    const sets = ["handover_to_id = ?", "handover_at = NOW()", "handover_notes = ?", "row_version = row_version + 1", "updated_by = ?"]
    const params: any[] = [toId, input.notes || null, actorId ?? null]
    if (input.reassign) {
      sets.splice(4, 0, "owner_id = ?")
      params.splice(3, 0, toId)
    }
    await conn.query(`UPDATE sales_onboarding SET ${sets.join(", ")} WHERE id = ?`, [...params, id])
    await logHistory(conn, { onboardingId: id, field: "handover", from: current.owner_id, to: toId, note: input.notes || null, changedBy: actorId })
    await recordAudit(conn, {
      entityType: "onboarding",
      entityId: id,
      action: "handover",
      summary: `Onboarding ${current.onboarding_code} handed over`,
      actorId,
    })
    await logActivity(conn, { onboardingId: id, type: "handover", title: "Handover recorded", body: input.notes || null, createdBy: actorId })
    await notify(conn, {
      userId: toId,
      type: "onboarding_handover",
      title: `Handover: ${current.onboarding_code}`,
      body: current.company_name || undefined,
      link: `/modules/sales/onboarding`,
      entityType: "onboarding",
      entityId: id,
    })
    await conn.commit()
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Record go-live details without forcing completion. */
export async function recordGoLive(
  id: number,
  input: { go_live_date?: string | null; notes?: string | null; expectedRowVersion?: number },
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_onboarding WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new OnboardingNotFoundError()
    if (input.expectedRowVersion != null && Number(input.expectedRowVersion) !== Number(current.row_version)) {
      throw new OnboardingConflictError()
    }
    await conn.query(
      `UPDATE sales_onboarding SET go_live_date = ?, go_live_notes = ?, current_stage = 'Go-Live',
        row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [input.go_live_date || todayISO(), input.notes || null, actorId ?? null, id],
    )
    await recordAudit(conn, { entityType: "onboarding", entityId: id, action: "go_live", summary: `Go-live recorded for ${current.onboarding_code}`, actorId })
    await logActivity(conn, { onboardingId: id, type: "go_live", title: "Go-live recorded", body: input.notes || null, createdBy: actorId })
    await conn.commit()
    await recomputeAndCache(id)
    return await getOnboarding(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Kickoff meeting (reuses the Meetings service, links both ways)
// ---------------------------------------------------------------------------

export async function scheduleKickoff(
  id: number,
  input: {
    meeting_date: string
    meeting_time?: string | null
    duration_minutes?: number
    agenda?: string | null
    location?: string | null
    attendees?: any
    create_google_meet?: boolean
  },
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(id)
  if (!record) throw new OnboardingNotFoundError()
  if (record.kickoff_meeting_id) {
    throw new OnboardingValidationError("A kickoff meeting is already scheduled for this onboarding.")
  }
  const meeting = await createMeeting(
    {
      meeting_date: input.meeting_date,
      meeting_time: input.meeting_time || null,
      duration_minutes: input.duration_minutes || 60,
      company_id: record.company_id,
      company_name: record.company_name,
      contact_id: record.contact_id,
      contact_person: record.contact_person,
      lead_id: record.lead_id,
      owner_id: record.owner_id,
      meeting_type: "Review",
      agenda: input.agenda || `Kickoff: ${record.company_name || record.onboarding_code}`,
      location: input.location || null,
      attendees: input.attendees,
      create_google_meet: input.create_google_meet,
    } as any,
    actorId,
  )
  const meetingId = Number(meeting?.id)
  await query(
    `UPDATE sales_onboarding SET kickoff_meeting_id = ?, kickoff_meeting_date = ?, row_version = row_version + 1 WHERE id = ?`,
    [meetingId, input.meeting_date, id],
  )
  await query(`UPDATE sales_meetings SET onboarding_id = ? WHERE id = ?`, [id, meetingId]).catch(() => {})
  await recordAudit(null, {
    entityType: "onboarding",
    entityId: id,
    action: "kickoff_scheduled",
    summary: `Kickoff meeting ${meeting?.meeting_code || ""} scheduled`,
    meta: { meeting_id: meetingId },
    actorId,
  })
  await logActivity(null, {
    onboardingId: id,
    type: "meeting",
    title: `Kickoff scheduled · ${meeting?.meeting_code || ""}`,
    refType: "meeting",
    refId: meeting?.meeting_code || meetingId,
    createdBy: actorId,
  })
  return await getOnboarding(id)
}

// ---------------------------------------------------------------------------
// Archive / restore / guarded delete
// ---------------------------------------------------------------------------

export async function archiveOnboarding(id: number, actorId: Actor): Promise<void> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(id)
  if (!record) throw new OnboardingNotFoundError()
  await query(`UPDATE sales_onboarding SET archived_at = NOW(), row_version = row_version + 1, updated_by = ? WHERE id = ?`, [
    actorId ?? null,
    id,
  ])
  await recordAudit(null, { entityType: "onboarding", entityId: id, action: "archive", summary: `Onboarding ${record.onboarding_code} archived`, actorId })
  await logActivity(null, { onboardingId: id, type: "archive", title: "Archived", createdBy: actorId })
}

export async function restoreOnboarding(id: number, actorId: Actor): Promise<void> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(id)
  if (!record) throw new OnboardingNotFoundError()
  await query(`UPDATE sales_onboarding SET archived_at = NULL, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [
    actorId ?? null,
    id,
  ])
  await recordAudit(null, { entityType: "onboarding", entityId: id, action: "restore", summary: `Onboarding ${record.onboarding_code} restored`, actorId })
  await logActivity(null, { onboardingId: id, type: "restore", title: "Restored", createdBy: actorId })
}

/**
 * Guarded hard delete. By default onboarding is archived, not deleted. A true
 * delete is only permitted for an already-archived record and cascades the
 * owned sub-entities. Callers must pass force=true.
 */
export async function deleteOnboarding(id: number, actorId: Actor, opts: { force?: boolean } = {}): Promise<void> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(id)
  if (!record) throw new OnboardingNotFoundError()
  if (!opts.force) {
    // Default path: soft-archive instead of destroying data.
    await archiveOnboarding(id, actorId)
    return
  }
  if (!record.archived_at) {
    throw new OnboardingValidationError("Archive the onboarding before permanently deleting it.")
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const t of [
      "sales_onboarding_checklist",
      "sales_onboarding_tasks",
      "sales_onboarding_milestones",
      "sales_onboarding_documents",
      "sales_onboarding_risks",
      "sales_onboarding_team",
      "sales_onboarding_activities",
      "sales_onboarding_history",
    ]) {
      await conn.query(`DELETE FROM \`${t}\` WHERE onboarding_id = ?`, [id])
    }
    await conn.query(`UPDATE sales_meetings SET onboarding_id = NULL WHERE onboarding_id = ?`, [id]).catch(() => {})
    await conn.query(`DELETE FROM sales_onboarding WHERE id = ?`, [id])
    await recordAudit(conn, { entityType: "onboarding", entityId: id, action: "delete", summary: `Onboarding ${record.onboarding_code} permanently deleted`, actorId })
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Sub-entity CRUD (checklist / task / milestone / document / risk / team)
// ---------------------------------------------------------------------------

const SUB_TABLE: Record<Exclude<SubItemKind, "team">, string> = {
  checklist: "sales_onboarding_checklist",
  task: "sales_onboarding_tasks",
  milestone: "sales_onboarding_milestones",
  document: "sales_onboarding_documents",
  risk: "sales_onboarding_risks",
}

const SUB_FIELDS: Record<Exclude<SubItemKind, "team">, string[]> = {
  checklist: ["title", "description", "stage", "is_required", "status", "owner_id", "due_date", "sort_order"],
  task: ["title", "description", "status", "priority", "owner_id", "due_date", "sort_order"],
  milestone: ["name", "description", "status", "due_date", "completed_date", "owner_id", "sort_order"],
  document: ["name", "doc_status", "is_required", "file_url", "owner_id", "due_date", "notes", "sort_order"],
  risk: ["title", "kind", "severity", "status", "mitigation", "owner_id", "due_date"],
}

function pickFields(kind: Exclude<SubItemKind, "team">, input: Record<string, any>) {
  const cols: string[] = []
  const vals: any[] = []
  for (const f of SUB_FIELDS[kind]) {
    if (input[f] !== undefined) {
      cols.push(f)
      vals.push(input[f] === "" ? null : input[f])
    }
  }
  return { cols, vals }
}

/** Auto-stamps completion timestamps when a sub-item reaches a done state. */
function completionPatch(kind: Exclude<SubItemKind, "team">, input: Record<string, any>): [string[], any[]] {
  const cols: string[] = []
  const vals: any[] = []
  if (kind === "checklist" && input.status !== undefined) {
    cols.push("completed_at")
    vals.push(input.status === "Done" ? new Date() : null)
  }
  if (kind === "task" && input.status !== undefined) {
    cols.push("completed_at")
    vals.push(input.status === "Done" ? new Date() : null)
  }
  if (kind === "milestone" && input.status !== undefined) {
    cols.push("completed_date")
    vals.push(input.status === "Done" ? todayISO() : null)
  }
  if (kind === "document" && input.doc_status !== undefined) {
    cols.push("verified_at")
    vals.push(input.doc_status === "Verified" ? new Date() : null)
  }
  if (kind === "risk" && input.status !== undefined) {
    cols.push("resolved_at")
    vals.push(input.status === "Resolved" ? new Date() : null)
  }
  return [cols, vals]
}

export async function addSubItem(
  onboardingId: number,
  kind: SubItemKind,
  input: Record<string, any>,
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(onboardingId)
  if (!record) throw new OnboardingNotFoundError()

  if (kind === "team") {
    const userId = Number(input.user_id)
    if (!userId) throw new OnboardingValidationError("A user is required")
    await query(
      `INSERT INTO sales_onboarding_team (onboarding_id, user_id, role, created_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [onboardingId, userId, input.role || null, actorId ?? null],
    )
    await logActivity(null, { onboardingId, type: "team", title: "Team member added", createdBy: actorId })
    return { ok: true }
  }

  const { cols, vals } = pickFields(kind, input)
  if (!cols.length) throw new OnboardingValidationError("Nothing to add")
  const [cCols, cVals] = completionPatch(kind, input)
  const allCols = ["onboarding_id", ...cols, ...cCols, "created_by"]
  const allVals = [onboardingId, ...vals, ...cVals, actorId ?? null]
  const [result] = await pool.query<any>(
    `INSERT INTO \`${SUB_TABLE[kind]}\` (${allCols.map((c) => `\`${c}\``).join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`,
    allVals,
  )
  await logActivity(null, {
    onboardingId,
    type: kind,
    title: `${kind[0].toUpperCase() + kind.slice(1)} added`,
    body: input.title || input.name || null,
    createdBy: actorId,
  })
  await recordAudit(null, { entityType: "onboarding", entityId: onboardingId, action: `${kind}_add`, summary: `${kind} added`, actorId })
  const res = await recomputeAndCache(onboardingId)
  return { id: Number(result.insertId), ...res }
}

export async function updateSubItem(
  onboardingId: number,
  kind: Exclude<SubItemKind, "team">,
  itemId: number,
  input: Record<string, any>,
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const { cols, vals } = pickFields(kind, input)
  const [cCols, cVals] = completionPatch(kind, input)
  const setCols = [...cols, ...cCols]
  if (!setCols.length) throw new OnboardingValidationError("Nothing to update")
  const setVals = [...vals, ...cVals]
  await query(
    `UPDATE \`${SUB_TABLE[kind]}\` SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE id = ? AND onboarding_id = ?`,
    [...setVals, itemId, onboardingId],
  )
  await logActivity(null, { onboardingId, type: kind, title: `${kind} updated`, createdBy: actorId })
  const res = await recomputeAndCache(onboardingId)
  return { ok: true, ...res }
}

export async function deleteSubItem(
  onboardingId: number,
  kind: SubItemKind,
  itemId: number,
  actorId: Actor,
): Promise<any> {
  await ensureOnboardingSchema()
  const table = kind === "team" ? "sales_onboarding_team" : SUB_TABLE[kind]
  await query(`DELETE FROM \`${table}\` WHERE id = ? AND onboarding_id = ?`, [itemId, onboardingId])
  await logActivity(null, { onboardingId, type: kind, title: `${kind} removed`, createdBy: actorId })
  const res = await recomputeAndCache(onboardingId)
  return { ok: true, ...res }
}

// ---------------------------------------------------------------------------
// Notes / activity
// ---------------------------------------------------------------------------

export async function addNote(onboardingId: number, body: string, actorId: Actor): Promise<void> {
  await ensureOnboardingSchema()
  await logActivity(null, { onboardingId, type: "note", title: "Note", body, createdBy: actorId })
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export async function getOnboardingAnalytics(): Promise<any> {
  await ensureOnboardingSchema()
  const [byStatus, byStage, byHealth, totals, overdue, avgDays] = await Promise.all([
    query<any[]>(`SELECT status, COUNT(*) AS c FROM sales_onboarding WHERE archived_at IS NULL GROUP BY status`),
    query<any[]>(`SELECT current_stage AS stage, COUNT(*) AS c FROM sales_onboarding WHERE archived_at IS NULL GROUP BY current_stage`),
    query<any[]>(`SELECT health, COUNT(*) AS c FROM sales_onboarding WHERE archived_at IS NULL GROUP BY health`),
    query<any[]>(
      `SELECT COUNT(*) AS total,
        SUM(status IN ('Not Started','In Progress','On Hold','Blocked')) AS active,
        SUM(status = 'Completed') AS completed,
        ROUND(AVG(progress_pct)) AS avg_progress
       FROM sales_onboarding WHERE archived_at IS NULL`,
    ),
    query<any[]>(
      `SELECT COUNT(*) AS c FROM sales_onboarding
       WHERE archived_at IS NULL AND status NOT IN ('Completed','Cancelled')
       AND target_completion_date IS NOT NULL AND target_completion_date < CURDATE()`,
    ),
    query<any[]>(
      `SELECT ROUND(AVG(DATEDIFF(completed_at, COALESCE(start_date, onboarding_date, created_at)))) AS avg_days
       FROM sales_onboarding WHERE completed_at IS NOT NULL`,
    ),
  ])
  return {
    byStatus,
    byStage,
    byHealth,
    totals: totals[0] || {},
    overdue: Number(overdue[0]?.c || 0),
    avgCompletionDays: Number(avgDays[0]?.avg_days || 0),
  }
}

export async function listTemplates(): Promise<any[]> {
  await ensureOnboardingSchema()
  return query<any[]>(`SELECT id, name, description, version, active FROM sales_onboarding_templates WHERE active = 1 ORDER BY name`)
}
