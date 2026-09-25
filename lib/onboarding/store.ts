import "server-only"

/**
 * Spec32 (#176-179) — First-run onboarding checklist persistence.
 * ---------------------------------------------------------------------------
 * Reuses existing subsystems as READ-ONLY signal sources instead of creating a
 * parallel setup tracker:
 *  - company / email / storage  → `company_settings` (Company Settings screens)
 *  - users                      → `users` (a tenant with >1 active user)
 *  - modules                    → `user_module_permissions` (access configured)
 *
 * It owns only the per-tenant override/dismissal row. Live completion of each
 * step is recalculated from the sources above on every read (never cached in
 * the row), so the checklist is always truthful. Every statement carries an
 * explicit `tenant_id = ?` taken from the caller (server-derived from the
 * session), never from a request body.
 */

import { query } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import {
  CHECKLIST_STEPS,
  computeChecklist,
  parseOverrides,
  type ChecklistStepKey,
  type ComputedChecklist,
  type StepOverrideInput,
} from "@/lib/onboarding/model"

const first = <T = any>(rows: any): T | undefined => (Array.isArray(rows) ? rows[0] : undefined)
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const isMissingTable = (err: unknown) => (err as { code?: string })?.code === "ER_NO_SUCH_TABLE"

let ensured: Promise<void> | null = null
export function ensureOnboardingSchema(): Promise<void> {
  if (!ensured) {
    ensured = query(`CREATE TABLE IF NOT EXISTS \`onboarding_checklist\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`dismissed\` TINYINT(1) NOT NULL DEFAULT 0,
      \`overrides\` JSON DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`updated_by\` INT UNSIGNED DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(() => undefined)
      .catch((err) => {
        ensured = null
        throw err
      })
  }
  return ensured
}

/** A signal source whose table does not exist on this install reads as "not done". */
async function safeCount(sql: string, params: any[]): Promise<number> {
  try {
    return num(first(await query<any[]>(sql, params))?.c)
  } catch (err) {
    if (isMissingTable(err)) return 0
    throw err
  }
}

/**
 * Live per-step completion signals for a tenant. company/email/storage read the
 * install-wide Company Settings key/value store; users and modules are scoped
 * to the tenant via an explicit predicate.
 */
export async function collectSignals(tenantId: number): Promise<Record<ChecklistStepKey, boolean>> {
  const [company, email, storage, users, modules] = await Promise.all([
    safeCount("SELECT COUNT(*) AS c FROM company_settings WHERE skey = 'company.name' AND svalue IS NOT NULL AND svalue <> ''", []),
    safeCount("SELECT COUNT(*) AS c FROM company_settings WHERE skey LIKE 'email.%' AND svalue IS NOT NULL AND svalue <> '' AND svalue NOT IN ('disabled','0','false')", []),
    safeCount("SELECT COUNT(*) AS c FROM company_settings WHERE skey = 'storage.provider' AND svalue IS NOT NULL AND svalue <> ''", []),
    safeCount("SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'active'", [tenantId]),
    safeCount(
      "SELECT COUNT(*) AS c FROM user_module_permissions ump JOIN users u ON u.id = ump.user_id WHERE u.tenant_id = ?",
      [tenantId],
    ),
  ])
  return {
    company: company > 0,
    email: email > 0,
    storage: storage > 0,
    users: users > 1,
    modules: modules > 0,
  }
}

/**
 * Which steps apply to this tenant. The modules step is dropped when the
 * install has no modules to configure, so it never inflates the denominator or
 * shows a step the tenant cannot act on (hidden-module case).
 */
export async function applicableSteps(): Promise<ChecklistStepKey[]> {
  const moduleCount = await safeCount("SELECT COUNT(*) AS c FROM modules", [])
  return CHECKLIST_STEPS.filter((k) => (k === "modules" ? moduleCount > 0 : true))
}

type Row = { dismissed: number; overrides: unknown }

async function loadRow(tenantId: number): Promise<Row | undefined> {
  return first(await query<any[]>("SELECT dismissed, overrides FROM onboarding_checklist WHERE tenant_id = ?", [tenantId]))
}

/** Full recalculated checklist for a tenant. */
export async function getChecklist(tenantId: number): Promise<ComputedChecklist> {
  await ensureOnboardingSchema()
  const [row, signals, applicable] = await Promise.all([loadRow(tenantId), collectSignals(tenantId), applicableSteps()])
  return computeChecklist({
    signals,
    overrides: parseOverrides(row?.overrides ?? null),
    dismissed: Boolean(num(row?.dismissed)),
    applicable,
  })
}

async function persist(tenantId: number, overrides: Partial<Record<ChecklistStepKey, "done" | "skipped">>, dismissed: boolean, userId: number, complete: boolean) {
  await query(
    `INSERT INTO onboarding_checklist (tenant_id, dismissed, overrides, completed_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE dismissed = VALUES(dismissed), overrides = VALUES(overrides),
       completed_at = VALUES(completed_at), updated_by = VALUES(updated_by)`,
    [tenantId, dismissed ? 1 : 0, JSON.stringify(overrides), complete ? new Date() : null, userId],
  )
}

/**
 * Set (or clear) a manual override for one step. Idempotent: re-applying the
 * same override reports `changed: false` and writes nothing.
 */
export async function setStepState(
  tenantId: number,
  userId: number,
  step: ChecklistStepKey,
  state: StepOverrideInput,
  auditCtx?: AuditContext,
): Promise<{ changed: boolean; checklist: ComputedChecklist }> {
  await ensureOnboardingSchema()
  const row = await loadRow(tenantId)
  const overrides = parseOverrides(row?.overrides ?? null)
  const dismissed = Boolean(num(row?.dismissed))
  const prev = overrides[step] ?? "todo"
  if (prev === state) {
    return { changed: false, checklist: await getChecklist(tenantId) }
  }
  if (state === "todo") delete overrides[step]
  else overrides[step] = state

  // Recompute against live signals to decide completion timestamp.
  const [signals, applicable] = await Promise.all([collectSignals(tenantId), applicableSteps()])
  const checklist = computeChecklist({ signals, overrides, dismissed, applicable })
  await persist(tenantId, overrides, dismissed, userId, checklist.complete)
  await recordAuditLog(
    {
      action: "onboarding.step_updated",
      entityType: "onboarding_checklist",
      entityId: String(tenantId),
      entityLabel: step,
      metadata: { step, from: prev, to: state, percent: checklist.percent },
      context: { tenantId },
    },
    auditCtx,
  )
  return { changed: true, checklist }
}

/** Dismiss or restore the checklist banner for a tenant. Idempotent. */
export async function setDismissed(
  tenantId: number,
  userId: number,
  dismissed: boolean,
  auditCtx?: AuditContext,
): Promise<{ changed: boolean; checklist: ComputedChecklist }> {
  await ensureOnboardingSchema()
  const row = await loadRow(tenantId)
  const overrides = parseOverrides(row?.overrides ?? null)
  const prev = Boolean(num(row?.dismissed))
  if (prev === dismissed) return { changed: false, checklist: await getChecklist(tenantId) }
  const [signals, applicable] = await Promise.all([collectSignals(tenantId), applicableSteps()])
  const checklist = computeChecklist({ signals, overrides, dismissed, applicable })
  await persist(tenantId, overrides, dismissed, userId, checklist.complete)
  await recordAuditLog(
    {
      action: dismissed ? "onboarding.dismissed" : "onboarding.restored",
      entityType: "onboarding_checklist",
      entityId: String(tenantId),
      context: { tenantId },
    },
    auditCtx,
  )
  return { changed: true, checklist }
}
