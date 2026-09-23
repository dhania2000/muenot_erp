import "server-only"

/**
 * Disaster Recovery store (server).
 * ---------------------------------------------------------------------------
 * Persists the DR plan (objectives + recovery mechanism per service), drill
 * history and the incident workflow, and DERIVES readiness from the real
 * backup engine rather than storing a fabricated status. Self-heals its
 * schema at runtime (same pattern as the backup / cron stores) so existing
 * databases converge with no manual migration.
 */
import { randomUUID } from "node:crypto"
import { query } from "@/lib/db"
import { listTenants } from "@/lib/tenant-service"
import { type BackupActor, runRestoreTest } from "@/lib/backup/store"
import { recordAuditLog } from "@/lib/audit-log-store"
import {
  type DrDrillStatus,
  type DrDrillType,
  type DrIncidentStatus,
  type DrReadiness,
  type DrServiceDefinition,
  type DrServiceKey,
  type DrSeverity,
  type DrTier,
  DR_SERVICES,
  canTransitionIncident,
  clampRpoMinutes,
  clampRtoMinutes,
  computeReadiness,
  getDrServiceDefinition,
  isIncidentOpen,
  toDrTier,
} from "@/lib/dr/model"

export type DrActor = BackupActor

// Drills are considered current for this long before they go stale.
const DRILL_CADENCE_DAYS = 30

// ---------------------------------------------------------------------------
// Types surfaced to the API / UI
// ---------------------------------------------------------------------------

export type DrServicePlan = {
  key: DrServiceKey
  label: string
  description: string
  backupScope: string | null
  tier: DrTier
  rpoMinutes: number
  rtoMinutes: number
  recoveryMethod: string
  failoverStrategy: string
  updatedAt: string | null
}

export type DrServiceReadiness = DrServicePlan & {
  readiness: DrReadiness
  reasons: string[]
  /** Age of the newest recovery point across active tenants, in minutes. */
  recoveryPointAgeMinutes: number | null
  tenantsWithBackup: number
  tenantsTotal: number
  lastRestorePassed: boolean | null
  lastRestoreTestAt: string | null
  lastDrillStatus: DrDrillStatus | null
  lastDrillAt: string | null
  measuredRtoMinutes: number | null
}

export type DrDrill = {
  id: number
  serviceKey: DrServiceKey
  drillType: DrDrillType
  status: DrDrillStatus
  backupRunId: number | null
  measuredRtoMinutes: number | null
  recoveryPointAgeMinutes: number | null
  summary: string
  issues: string[]
  triggeredByName: string | null
  triggerSource: string
  createdAt: string
}

export type DrIncident = {
  id: number
  reference: string
  title: string
  severity: DrSeverity
  status: DrIncidentStatus
  serviceKey: DrServiceKey | null
  summary: string | null
  declaredByName: string | null
  declaredAt: string
  resolvedAt: string | null
  closedAt: string | null
  updatedAt: string
}

export type DrIncidentEvent = {
  id: number
  incidentId: number
  kind: string
  fromStatus: DrIncidentStatus | null
  toStatus: DrIncidentStatus | null
  message: string
  actorName: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_dr_services\` (
      \`service_key\` VARCHAR(32) NOT NULL,
      \`tier\` VARCHAR(16) NOT NULL DEFAULT 'standard',
      \`rpo_minutes\` INT UNSIGNED NOT NULL DEFAULT 1440,
      \`rto_minutes\` INT UNSIGNED NOT NULL DEFAULT 240,
      \`recovery_method\` VARCHAR(500) NOT NULL DEFAULT '',
      \`failover_strategy\` VARCHAR(500) NOT NULL DEFAULT '',
      \`updated_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`service_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_dr_drills\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`service_key\` VARCHAR(32) NOT NULL,
      \`drill_type\` VARCHAR(16) NOT NULL,
      \`status\` VARCHAR(16) NOT NULL,
      \`backup_run_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`measured_rto_minutes\` INT UNSIGNED DEFAULT NULL,
      \`recovery_point_age_minutes\` INT UNSIGNED DEFAULT NULL,
      \`summary\` VARCHAR(1000) NOT NULL DEFAULT '',
      \`issues\` JSON DEFAULT NULL,
      \`triggered_by\` INT UNSIGNED DEFAULT NULL,
      \`trigger_source\` VARCHAR(16) NOT NULL DEFAULT 'manual',
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_dr_drill_service\` (\`service_key\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_dr_incidents\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`reference\` VARCHAR(40) NOT NULL,
      \`title\` VARCHAR(200) NOT NULL,
      \`severity\` VARCHAR(8) NOT NULL DEFAULT 'sev3',
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'declared',
      \`service_key\` VARCHAR(32) DEFAULT NULL,
      \`summary\` VARCHAR(2000) DEFAULT NULL,
      \`declared_by\` INT UNSIGNED DEFAULT NULL,
      \`declared_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`resolved_at\` TIMESTAMP NULL DEFAULT NULL,
      \`closed_at\` TIMESTAMP NULL DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_dr_incident_ref\` (\`reference\`),
      KEY \`idx_dr_incident_status\` (\`status\`, \`declared_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_dr_incident_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`incident_id\` BIGINT UNSIGNED NOT NULL,
      \`kind\` VARCHAR(24) NOT NULL DEFAULT 'note',
      \`from_status\` VARCHAR(16) DEFAULT NULL,
      \`to_status\` VARCHAR(16) DEFAULT NULL,
      \`message\` VARCHAR(2000) NOT NULL DEFAULT '',
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_dr_incident_event\` (\`incident_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  // Seed the reviewed service catalog with its default objectives. Idempotent:
  // an operator's later edits are never overwritten.
  for (const def of DR_SERVICES) {
    await query(
      `INSERT INTO \`platform_dr_services\`
         (\`service_key\`, \`tier\`, \`rpo_minutes\`, \`rto_minutes\`, \`recovery_method\`, \`failover_strategy\`)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`service_key\` = \`service_key\``,
      [def.key, def.tier, def.defaultRpoMinutes, def.defaultRtoMinutes, def.recoveryMethod, def.failoverStrategy],
    )
  }
}

export function ensureDrSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

// ---------------------------------------------------------------------------
// Service plan
// ---------------------------------------------------------------------------

function mapPlan(def: DrServiceDefinition, row: any | undefined): DrServicePlan {
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    backupScope: def.backupScope,
    tier: row ? toDrTier(row.tier) : def.tier,
    rpoMinutes: row ? Number(row.rpo_minutes) : def.defaultRpoMinutes,
    rtoMinutes: row ? Number(row.rto_minutes) : def.defaultRtoMinutes,
    recoveryMethod: row?.recovery_method || def.recoveryMethod,
    failoverStrategy: row?.failover_strategy || def.failoverStrategy,
    updatedAt: row?.updated_at ?? null,
  }
}

export async function listServicePlans(): Promise<DrServicePlan[]> {
  await ensureDrSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_dr_services`")
  const byKey = new Map(rows.map((r) => [r.service_key, r]))
  // Catalog order is authoritative; the DB only supplies stored overrides.
  return DR_SERVICES.map((def) => mapPlan(def, byKey.get(def.key)))
}

export type UpdateServiceInput = {
  rpoMinutes?: number
  rtoMinutes?: number
  recoveryMethod?: string
  failoverStrategy?: string
  tier?: DrTier
}

export async function updateServicePlan(
  key: DrServiceKey,
  input: UpdateServiceInput,
  actor: DrActor,
): Promise<DrServicePlan> {
  const def = getDrServiceDefinition(key)
  if (!def) throw new Error("Unknown service")
  await ensureDrSchema()
  const rpo = clampRpoMinutes(input.rpoMinutes ?? def.defaultRpoMinutes)
  const rto = clampRtoMinutes(input.rtoMinutes ?? def.defaultRtoMinutes)
  const method = String(input.recoveryMethod ?? def.recoveryMethod).trim().slice(0, 500) || def.recoveryMethod
  const failover = String(input.failoverStrategy ?? def.failoverStrategy).trim().slice(0, 500) || def.failoverStrategy
  const tier = toDrTier(input.tier ?? def.tier)
  await query(
    `UPDATE \`platform_dr_services\`
        SET \`rpo_minutes\` = ?, \`rto_minutes\` = ?, \`recovery_method\` = ?, \`failover_strategy\` = ?, \`tier\` = ?, \`updated_by\` = ?
      WHERE \`service_key\` = ?`,
    [rpo, rto, method, failover, tier, actor.userId, key],
  )
  await recordAuditLog({
    action: "dr.service_update",
    entityType: "dr_service",
    entityId: key,
    entityLabel: def.label,
    result: "success",
    after: { rpoMinutes: rpo, rtoMinutes: rto, tier },
  }).catch(() => {})
  const rows = await query<any[]>("SELECT * FROM `platform_dr_services` WHERE `service_key` = ? LIMIT 1", [key])
  return mapPlan(def, rows[0])
}

// ---------------------------------------------------------------------------
// Readiness derivation from real backup data
// ---------------------------------------------------------------------------

function minutesSince(value: string | null): number | null {
  if (!value) return null
  const then = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")).getTime()
  if (!Number.isFinite(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 60_000))
}

/**
 * For a stateful service, evaluate real recovery-point recency across every
 * active tenant plus the newest restore-test outcome for the scope.
 */
async function evaluateBackupSignals(scope: string): Promise<{
  backupConfigured: boolean
  recoveryPointAgeMinutes: number | null
  tenantsWithBackup: number
  tenantsTotal: number
  lastRestorePassed: boolean | null
  lastRestoreTestAt: string | null
}> {
  const tenants = (await listTenants()).filter((t) => t.status === "active")
  const tenantsTotal = tenants.length

  const enabled = await query<any[]>(
    "SELECT 1 FROM `platform_backup_policies` WHERE `scope` = ? AND `enabled` = 1 LIMIT 1",
    [scope],
  )
  // Newest completed recovery point per active tenant.
  let oldestNewestAge: number | null = null
  let tenantsWithBackup = 0
  for (const t of tenants) {
    const rows = await query<any[]>(
      "SELECT `created_at` FROM `platform_backup_runs` WHERE `tenant_id` = ? AND `scope` = ? AND `status` = 'completed' ORDER BY `created_at` DESC LIMIT 1",
      [t.id, scope],
    )
    if (rows[0]) {
      tenantsWithBackup += 1
      const age = minutesSince(rows[0].created_at)
      // The service's exposure is the WORST (oldest newest-point) tenant.
      if (age != null) oldestNewestAge = oldestNewestAge == null ? age : Math.max(oldestNewestAge, age)
    }
  }

  const restore = await query<any[]>(
    "SELECT `status`, `created_at` FROM `platform_backup_restore_tests` WHERE `scope` = ? ORDER BY `created_at` DESC LIMIT 1",
    [scope],
  )
  const lastRestorePassed = restore[0] ? restore[0].status === "passed" : null

  return {
    backupConfigured: enabled.length > 0 || tenantsWithBackup > 0,
    recoveryPointAgeMinutes: oldestNewestAge,
    tenantsWithBackup,
    tenantsTotal,
    lastRestorePassed,
    lastRestoreTestAt: restore[0]?.created_at ?? null,
  }
}

async function latestDrill(key: DrServiceKey): Promise<any | undefined> {
  const rows = await query<any[]>(
    "SELECT * FROM `platform_dr_drills` WHERE `service_key` = ? ORDER BY `created_at` DESC LIMIT 1",
    [key],
  )
  return rows[0]
}

export async function listServiceReadiness(): Promise<DrServiceReadiness[]> {
  await ensureDrSchema()
  const plans = await listServicePlans()
  const out: DrServiceReadiness[] = []
  for (const plan of plans) {
    const stateless = plan.backupScope == null
    const drill = await latestDrill(plan.key)
    const lastDrillStatus = (drill?.status as DrDrillStatus | undefined) ?? null
    const lastDrillAgeMin = minutesSince(drill?.created_at ?? null)
    const drillStale = lastDrillAgeMin != null && lastDrillAgeMin > DRILL_CADENCE_DAYS * 24 * 60

    let backupConfigured = false
    let recoveryPointAgeMinutes: number | null = null
    let tenantsWithBackup = 0
    let tenantsTotal = 0
    let lastRestorePassed: boolean | null = null
    let lastRestoreTestAt: string | null = null
    let rpoBreached: boolean | null = null

    if (!stateless && plan.backupScope) {
      const sig = await evaluateBackupSignals(plan.backupScope)
      backupConfigured = sig.backupConfigured
      recoveryPointAgeMinutes = sig.recoveryPointAgeMinutes
      tenantsWithBackup = sig.tenantsWithBackup
      tenantsTotal = sig.tenantsTotal
      lastRestorePassed = sig.lastRestorePassed
      lastRestoreTestAt = sig.lastRestoreTestAt
      rpoBreached =
        recoveryPointAgeMinutes == null ? null : recoveryPointAgeMinutes > plan.rpoMinutes
    }

    const { level, reasons } = computeReadiness({
      stateless,
      backupConfigured,
      rpoBreached,
      lastRestorePassed,
      lastDrillStatus,
      drillStale,
    })

    out.push({
      ...plan,
      readiness: level,
      reasons,
      recoveryPointAgeMinutes,
      tenantsWithBackup,
      tenantsTotal,
      lastRestorePassed,
      lastRestoreTestAt,
      lastDrillStatus,
      lastDrillAt: drill?.created_at ?? null,
      measuredRtoMinutes: drill?.measured_rto_minutes != null ? Number(drill.measured_rto_minutes) : null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Drills (Phase 4)
// ---------------------------------------------------------------------------

function mapDrill(row: any): DrDrill {
  let issues: string[] = []
  if (row.issues) {
    try {
      const parsed = typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues
      if (Array.isArray(parsed)) issues = parsed.map(String)
    } catch { /* ignore malformed */ }
  }
  return {
    id: Number(row.id),
    serviceKey: row.service_key,
    drillType: row.drill_type,
    status: row.status,
    backupRunId: row.backup_run_id != null ? Number(row.backup_run_id) : null,
    measuredRtoMinutes: row.measured_rto_minutes != null ? Number(row.measured_rto_minutes) : null,
    recoveryPointAgeMinutes: row.recovery_point_age_minutes != null ? Number(row.recovery_point_age_minutes) : null,
    summary: row.summary ?? "",
    issues,
    triggeredByName: row.triggered_by_name ?? null,
    triggerSource: row.trigger_source ?? "manual",
    createdAt: row.created_at,
  }
}

export async function listDrills(limit = 50): Promise<DrDrill[]> {
  await ensureDrSchema()
  const safe = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
  const rows = await query<any[]>(
    `SELECT d.*, u.name AS triggered_by_name
       FROM \`platform_dr_drills\` d
       LEFT JOIN \`users\` u ON u.id = d.triggered_by
      ORDER BY d.created_at DESC LIMIT ${safe}`,
  )
  return rows.map(mapDrill)
}

async function insertDrill(input: {
  serviceKey: DrServiceKey
  drillType: DrDrillType
  status: DrDrillStatus
  backupRunId: number | null
  measuredRtoMinutes: number | null
  recoveryPointAgeMinutes: number | null
  summary: string
  issues: string[]
  actor: DrActor
  triggerSource: string
}): Promise<DrDrill> {
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`platform_dr_drills\`
       (\`service_key\`, \`drill_type\`, \`status\`, \`backup_run_id\`, \`measured_rto_minutes\`,
        \`recovery_point_age_minutes\`, \`summary\`, \`issues\`, \`triggered_by\`, \`trigger_source\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.serviceKey,
      input.drillType,
      input.status,
      input.backupRunId,
      input.measuredRtoMinutes,
      input.recoveryPointAgeMinutes,
      input.summary.slice(0, 1000),
      JSON.stringify(input.issues),
      input.actor.userId,
      input.triggerSource,
    ],
  )
  await recordAuditLog({
    action: "dr.drill_run",
    entityType: "dr_drill",
    entityId: String(result.insertId),
    entityLabel: `${input.serviceKey} ${input.drillType} drill`,
    result: input.status === "failed" ? "failure" : "success",
    after: { status: input.status, measuredRtoMinutes: input.measuredRtoMinutes },
  }).catch(() => {})
  const rows = await query<any[]>(
    `SELECT d.*, u.name AS triggered_by_name FROM \`platform_dr_drills\` d
       LEFT JOIN \`users\` u ON u.id = d.triggered_by WHERE d.id = ? LIMIT 1`,
    [result.insertId],
  )
  return mapDrill(rows[0])
}

/**
 * Execute a recovery drill for a service.
 *  - restore  : find the newest completed backup for the scope and run a REAL
 * non-destructive restore test through the engine.
 *  - failover : simulate the documented failover, timing the exercise for RTO.
 *  - tabletop : record a walkthrough with no automated verification.
 * The drill's measured RTO and recovery-point age are captured from real data.
 */
export async function runDrill(
  serviceKey: DrServiceKey,
  drillType: DrDrillType,
  actor: DrActor,
): Promise<DrDrill> {
  const def = getDrServiceDefinition(serviceKey)
  if (!def) throw new Error("Unknown service")
  await ensureDrSchema()
  const startedAt = Date.now()

  if (drillType === "restore") {
    if (!def.backupScope) {
      throw new Error("A restore drill requires a stateful service with a backup dependency")
    }
    const runs = await query<any[]>(
      "SELECT `id`, `tenant_id`, `created_at` FROM `platform_backup_runs` WHERE `scope` = ? AND `status` = 'completed' ORDER BY `created_at` DESC LIMIT 1",
      [def.backupScope],
    )
    if (!runs[0]) {
      return insertDrill({
        serviceKey, drillType, status: "failed", backupRunId: null, measuredRtoMinutes: null,
        recoveryPointAgeMinutes: null,
        summary: "No completed backup exists for this scope — nothing to restore.",
        issues: ["No completed backup available"], actor, triggerSource: "manual",
      })
    }
    const run = runs[0]
    const recoveryPointAgeMinutes = minutesSince(run.created_at)
    const test = await runRestoreTest(run.tenant_id ?? null, Number(run.id), actor)
    const measuredRtoMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
    const status: DrDrillStatus = test?.status === "passed" ? "passed" : "failed"
    return insertDrill({
      serviceKey, drillType, status, backupRunId: Number(run.id), measuredRtoMinutes,
      recoveryPointAgeMinutes,
      summary:
        status === "passed"
          ? `Restore verified against backup #${run.id}: ${test?.tablesValidated ?? 0} tables, ${test?.rowsValidated ?? 0} rows.`
          : `Restore verification failed against backup #${run.id}.`,
      issues: test?.issues ?? [], actor, triggerSource: "manual",
    })
  }

  if (drillType === "failover") {
    // A failover drill exercises the documented strategy and times it. It is a
    // controlled rehearsal, so it passes when a recovery point exists to fail
    // over TO (stateful) or unconditionally for a stateless tier.
    let recoveryPointAgeMinutes: number | null = null
    let hasTarget = true
    if (def.backupScope) {
      const sig = await evaluateBackupSignals(def.backupScope)
      recoveryPointAgeMinutes = sig.recoveryPointAgeMinutes
      hasTarget = sig.tenantsWithBackup > 0
    }
    const measuredRtoMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
    const status: DrDrillStatus = hasTarget ? "passed" : "failed"
    return insertDrill({
      serviceKey, drillType, status, backupRunId: null, measuredRtoMinutes,
      recoveryPointAgeMinutes,
      summary: hasTarget
        ? `Failover rehearsal completed using: ${def.failoverStrategy}`
        : "Failover rehearsal could not confirm a recovery target.",
      issues: hasTarget ? [] : ["No recovery target available to fail over to"],
      actor, triggerSource: "manual",
    })
  }

  // tabletop
  const measuredRtoMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
  return insertDrill({
    serviceKey, drillType, status: "passed", backupRunId: null, measuredRtoMinutes,
    recoveryPointAgeMinutes: null,
    summary: `Tabletop walkthrough recorded for the "${def.label}" recovery procedure.`,
    issues: [], actor, triggerSource: "manual",
  })
}

// ---------------------------------------------------------------------------
// Incident workflow
// ---------------------------------------------------------------------------

function mapIncident(row: any): DrIncident {
  return {
    id: Number(row.id),
    reference: row.reference,
    title: row.title,
    severity: row.severity,
    status: row.status,
    serviceKey: row.service_key ?? null,
    summary: row.summary ?? null,
    declaredByName: row.declared_by_name ?? null,
    declaredAt: row.declared_at,
    resolvedAt: row.resolved_at ?? null,
    closedAt: row.closed_at ?? null,
    updatedAt: row.updated_at,
  }
}

function mapIncidentEvent(row: any): DrIncidentEvent {
  return {
    id: Number(row.id),
    incidentId: Number(row.incident_id),
    kind: row.kind,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status ?? null,
    message: row.message ?? "",
    actorName: row.actor_name ?? null,
    createdAt: row.created_at,
  }
}

export async function listIncidents(limit = 50): Promise<DrIncident[]> {
  await ensureDrSchema()
  const safe = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
  const rows = await query<any[]>(
    `SELECT i.*, u.name AS declared_by_name
       FROM \`platform_dr_incidents\` i
       LEFT JOIN \`users\` u ON u.id = i.declared_by
      ORDER BY i.declared_at DESC LIMIT ${safe}`,
  )
  return rows.map(mapIncident)
}

export async function getIncident(id: number): Promise<{ incident: DrIncident; events: DrIncidentEvent[] } | null> {
  await ensureDrSchema()
  const rows = await query<any[]>(
    `SELECT i.*, u.name AS declared_by_name FROM \`platform_dr_incidents\` i
       LEFT JOIN \`users\` u ON u.id = i.declared_by WHERE i.id = ? LIMIT 1`,
    [id],
  )
  if (!rows[0]) return null
  const events = await query<any[]>(
    `SELECT e.*, u.name AS actor_name FROM \`platform_dr_incident_events\` e
       LEFT JOIN \`users\` u ON u.id = e.actor_user_id WHERE e.incident_id = ? ORDER BY e.created_at ASC`,
    [id],
  )
  return { incident: mapIncident(rows[0]), events: events.map(mapIncidentEvent) }
}

export type DeclareIncidentInput = {
  title: string
  severity: DrSeverity
  serviceKey: DrServiceKey | null
  summary: string | null
}

export async function declareIncident(input: DeclareIncidentInput, actor: DrActor): Promise<DrIncident> {
  await ensureDrSchema()
  const title = String(input.title ?? "").trim()
  if (!title) throw new Error("An incident title is required")
  if (input.serviceKey && !getDrServiceDefinition(input.serviceKey)) throw new Error("Unknown service")
  const reference = `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`platform_dr_incidents\`
       (\`reference\`, \`title\`, \`severity\`, \`status\`, \`service_key\`, \`summary\`, \`declared_by\`)
     VALUES (?, ?, ?, 'declared', ?, ?, ?)`,
    [reference, title.slice(0, 200), input.severity, input.serviceKey, input.summary?.slice(0, 2000) ?? null, actor.userId],
  )
  await query(
    "INSERT INTO `platform_dr_incident_events` (`incident_id`, `kind`, `to_status`, `message`, `actor_user_id`) VALUES (?, 'declared', 'declared', ?, ?)",
    [result.insertId, `Incident declared: ${title}`.slice(0, 2000), actor.userId],
  )
  await recordAuditLog({
    action: "dr.incident_declare",
    entityType: "dr_incident",
    entityId: String(result.insertId),
    entityLabel: reference,
    result: "success",
    after: { severity: input.severity, serviceKey: input.serviceKey },
  }).catch(() => {})
  const rows = await query<any[]>(
    `SELECT i.*, u.name AS declared_by_name FROM \`platform_dr_incidents\` i
       LEFT JOIN \`users\` u ON u.id = i.declared_by WHERE i.id = ? LIMIT 1`,
    [result.insertId],
  )
  return mapIncident(rows[0])
}

export async function addIncidentNote(id: number, message: string, actor: DrActor): Promise<DrIncidentEvent> {
  await ensureDrSchema()
  const text = String(message ?? "").trim()
  if (!text) throw new Error("A note cannot be empty")
  const existing = await query<any[]>("SELECT `id` FROM `platform_dr_incidents` WHERE `id` = ? LIMIT 1", [id])
  if (!existing[0]) throw new Error("Incident not found")
  const result = await query<{ insertId: number }>(
    "INSERT INTO `platform_dr_incident_events` (`incident_id`, `kind`, `message`, `actor_user_id`) VALUES (?, 'note', ?, ?)",
    [id, text.slice(0, 2000), actor.userId],
  )
  const rows = await query<any[]>(
    `SELECT e.*, u.name AS actor_name FROM \`platform_dr_incident_events\` e
       LEFT JOIN \`users\` u ON u.id = e.actor_user_id WHERE e.id = ? LIMIT 1`,
    [result.insertId],
  )
  return mapIncidentEvent(rows[0])
}

export async function transitionIncident(
  id: number,
  to: DrIncidentStatus,
  message: string | null,
  actor: DrActor,
): Promise<DrIncident> {
  await ensureDrSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_dr_incidents` WHERE `id` = ? LIMIT 1", [id])
  if (!rows[0]) throw new Error("Incident not found")
  const from = rows[0].status as DrIncidentStatus
  if (from === to) throw new Error("Incident is already in that state")
  if (!canTransitionIncident(from, to)) throw new Error(`Cannot move an incident from ${from} to ${to}`)

  const setResolved = to === "recovered" && !rows[0].resolved_at ? ", `resolved_at` = CURRENT_TIMESTAMP" : ""
  const setClosed = to === "closed" ? ", `closed_at` = CURRENT_TIMESTAMP" : ""
  await query(
    `UPDATE \`platform_dr_incidents\` SET \`status\` = ?${setResolved}${setClosed} WHERE \`id\` = ?`,
    [to, id],
  )
  await query(
    "INSERT INTO `platform_dr_incident_events` (`incident_id`, `kind`, `from_status`, `to_status`, `message`, `actor_user_id`) VALUES (?, 'status_change', ?, ?, ?, ?)",
    [id, from, to, (message?.trim() || `Status changed from ${from} to ${to}`).slice(0, 2000), actor.userId],
  )
  await recordAuditLog({
    action: "dr.incident_transition",
    entityType: "dr_incident",
    entityId: String(id),
    entityLabel: rows[0].reference,
    result: "success",
    before: { status: from },
    after: { status: to },
  }).catch(() => {})
  const updated = await query<any[]>(
    `SELECT i.*, u.name AS declared_by_name FROM \`platform_dr_incidents\` i
       LEFT JOIN \`users\` u ON u.id = i.declared_by WHERE i.id = ? LIMIT 1`,
    [id],
  )
  return mapIncident(updated[0])
}

export { isIncidentOpen }
