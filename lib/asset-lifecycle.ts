import "server-only"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { notify } from "@/lib/sales/lead-lifecycle"
import type { SessionPayload } from "@/lib/auth"
import {
  AssetLifecycleError,
  OPEN_MAINTENANCE_STATUSES,
  validateMaintenanceInput,
  validateWarrantyInput,
  type MaintenanceInput,
  type WarrantyInput,
} from "@/lib/asset-lifecycle-model"

/**
 * Asset Warranty & Maintenance — a lifecycle layer over Finance → Fixed Assets.
 * ---------------------------------------------------------------------------
 * Reuses the existing subsystems rather than duplicating them:
 *   • Finance `fixed_assets` stays the source of truth for the asset itself
 *     (name / category / status / cost / depreciation). We only reference it by
 *     `asset_id` and never write to it here.
 *   • Warranty/service reminders flow through the unified Document Expiry sweep
 *     (lib/expiry/*) — this module exposes the rows; the sweep notifies.
 *   • Audit trail reuses the `employee_asset_audit` table (asset-scoped rows),
 *     so there is one asset audit log, not two.
 *
 * Server-side guarantees: input validation (lib/asset-lifecycle-model), audit on
 * every mutation, best-effort owner notification, and idempotent maintenance
 * creation via a unique idempotency key.
 */

export { AssetLifecycleError } from "@/lib/asset-lifecycle-model"

export const PERMISSION_KEY = "assets.employee_assets"
const WARRANTY_LINK = "/modules/assets/asset-lifecycle"

// ── Schema (self-healing) ────────────────────────────────────────────────────

let schemaEnsured = false

export async function ensureAssetLifecycleSchema(): Promise<void> {
  if (schemaEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS asset_warranties (
    id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
    warranty_id             VARCHAR(30) NOT NULL,
    finance_fixed_asset_id  VARCHAR(30) NOT NULL,
    provider                VARCHAR(190) NOT NULL,
    warranty_type           VARCHAR(30) NOT NULL DEFAULT 'Manufacturer',
    coverage                TEXT DEFAULT NULL,
    start_date              DATE DEFAULT NULL,
    expiry_date             DATE NOT NULL,
    reference_no            VARCHAR(120) DEFAULT NULL,
    cost                    DECIMAL(15,2) NOT NULL DEFAULT 0,
    reminder_days           INT UNSIGNED NOT NULL DEFAULT 30,
    notes                   TEXT DEFAULT NULL,
    archived_at             DATETIME DEFAULT NULL,
    created_by              INT UNSIGNED DEFAULT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_warranty_id (warranty_id),
    KEY idx_warranty_asset (finance_fixed_asset_id),
    KEY idx_warranty_expiry (expiry_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS asset_maintenance_records (
    id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
    maintenance_id          VARCHAR(30) NOT NULL,
    finance_fixed_asset_id  VARCHAR(30) NOT NULL,
    assignment_id           VARCHAR(30) DEFAULT NULL,
    maintenance_type        VARCHAR(30) NOT NULL DEFAULT 'Corrective',
    status                  VARCHAR(20) NOT NULL DEFAULT 'Scheduled',
    scheduled_date          DATE DEFAULT NULL,
    performed_date          DATE DEFAULT NULL,
    vendor_party_id         VARCHAR(30) DEFAULT NULL,
    vendor_name             VARCHAR(190) DEFAULT NULL,
    cost                    DECIMAL(15,2) NOT NULL DEFAULT 0,
    description             TEXT NOT NULL,
    next_service_date       DATE DEFAULT NULL,
    reminder_days           INT UNSIGNED NOT NULL DEFAULT 15,
    notes                   TEXT DEFAULT NULL,
    idempotency_key         VARCHAR(80) DEFAULT NULL,
    created_by              INT UNSIGNED DEFAULT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_maintenance_id (maintenance_id),
    UNIQUE KEY uq_maintenance_idem (idempotency_key),
    KEY idx_maint_asset (finance_fixed_asset_id),
    KEY idx_maint_status (status),
    KEY idx_maint_next_service (next_service_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Audit table is owned by lib/employee-assets; create defensively so this
  // module works even if warranty/maintenance is used before any assignment.
  await query(`CREATE TABLE IF NOT EXISTS employee_asset_audit (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    assignment_id  VARCHAR(30) DEFAULT NULL,
    asset_id       VARCHAR(30) DEFAULT NULL,
    action         VARCHAR(40) NOT NULL,
    user_id        INT UNSIGNED DEFAULT NULL,
    user_name      VARCHAR(190) DEFAULT NULL,
    old_value      TEXT DEFAULT NULL,
    new_value      TEXT DEFAULT NULL,
    reason         VARCHAR(255) DEFAULT NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_eaudit_assignment (assignment_id),
    KEY idx_eaudit_asset (asset_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function recordAudit(input: {
  assetId: string
  action: string
  userId?: number | null
  userName?: string | null
  oldValue?: unknown
  newValue?: unknown
  reason?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO employee_asset_audit (assignment_id, asset_id, action, user_id, user_name, old_value, new_value, reason)
     VALUES (NULL,?,?,?,?,?,?,?)`,
    [
      input.assetId,
      input.action,
      input.userId ?? null,
      input.userName ?? null,
      input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      input.newValue != null ? JSON.stringify(input.newValue) : null,
      input.reason ?? null,
    ],
  ).catch((e) => console.log("[v0] asset lifecycle audit insert failed", (e as Error).message))
}

/** Verify the referenced fixed asset exists; return its name for labelling. */
async function requireAsset(assetId: string): Promise<{ asset_id: string; asset_name: string | null }> {
  const rows = (await query(
    `SELECT asset_id, asset_name FROM fixed_assets WHERE asset_id = ? LIMIT 1`,
    [assetId],
  ).catch(() => [])) as any[]
  const row = rows[0]
  if (!row) throw new AssetLifecycleError("Selected asset does not exist in Fixed Assets.", 404)
  return { asset_id: String(row.asset_id), asset_name: row.asset_name ?? null }
}

/** Notify the current active assignee (if any) about an asset lifecycle event. */
async function notifyAssignee(
  assetId: string,
  input: { title: string; body: string; entityId?: string | null },
): Promise<void> {
  const rows = (await query(
    `SELECT e.user_id AS user_id
       FROM employee_asset_assignments a
       JOIN hr_employees e ON e.id = a.employee_id
      WHERE a.finance_fixed_asset_id = ? AND a.status IN ('Assigned','Under Repair')
      ORDER BY a.id DESC LIMIT 1`,
    [assetId],
  ).catch(() => [])) as any[]
  const userId = rows[0]?.user_id ? Number(rows[0].user_id) : null
  if (!userId) return
  await notify(null, {
    userId,
    type: "asset-lifecycle",
    title: input.title,
    body: input.body,
    link: WARRANTY_LINK,
    entityType: "asset_warranty",
    entityId: input.entityId ?? null,
  }).catch(() => {})
}

// ── Warranty CRUD ────────────────────────────────────────────────────────────

export async function listWarranties(params: { asset_id?: string | null } = {}) {
  await ensureAssetLifecycleSchema()
  const where: string[] = ["w.archived_at IS NULL"]
  const args: any[] = []
  if (params.asset_id) {
    where.push("w.finance_fixed_asset_id = ?")
    args.push(params.asset_id)
  }
  const rows = (await query(
    `SELECT w.*, fa.asset_name, fa.asset_category, fa.status AS asset_status
       FROM asset_warranties w
       LEFT JOIN fixed_assets fa ON fa.asset_id = w.finance_fixed_asset_id
      WHERE ${where.join(" AND ")}
      ORDER BY w.expiry_date ASC
      LIMIT 2000`,
    args,
  ).catch(() => [])) as any[]
  return rows
}

export async function createWarranty(input: WarrantyInput, session: SessionPayload) {
  await ensureAssetLifecycleSchema()
  const data = validateWarrantyInput(input, false)
  const asset = await requireAsset(data.finance_fixed_asset_id)

  const warrantyId = await nextRecordId("WTY", { digits: 6, allowCustom: true })
  await query(
    `INSERT INTO asset_warranties
       (warranty_id, finance_fixed_asset_id, provider, warranty_type, coverage, start_date, expiry_date,
        reference_no, cost, reminder_days, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      warrantyId,
      data.finance_fixed_asset_id,
      data.provider,
      data.warranty_type,
      data.coverage,
      data.start_date,
      data.expiry_date,
      data.reference_no,
      data.cost,
      data.reminder_days,
      data.notes,
      session.userId,
    ],
  )
  await recordAudit({
    assetId: data.finance_fixed_asset_id,
    action: "warranty_added",
    userId: session.userId,
    userName: session.name,
    newValue: { warrantyId, provider: data.provider, expiry_date: data.expiry_date, type: data.warranty_type },
  })
  await notifyAssignee(data.finance_fixed_asset_id, {
    title: "Warranty recorded",
    body: `${data.warranty_type} warranty for ${asset.asset_name ?? asset.asset_id} valid until ${data.expiry_date}.`,
    entityId: warrantyId,
  })
  return { warranty_id: warrantyId }
}

export async function updateWarranty(warrantyId: string, input: WarrantyInput, session: SessionPayload) {
  await ensureAssetLifecycleSchema()
  const current = (await query(`SELECT * FROM asset_warranties WHERE warranty_id = ? LIMIT 1`, [warrantyId]).catch(
    () => [],
  )) as any[]
  const row = current[0]
  if (!row) throw new AssetLifecycleError("Warranty not found.", 404)

  const data = validateWarrantyInput({ ...input, finance_fixed_asset_id: row.finance_fixed_asset_id }, true)
  await query(
    `UPDATE asset_warranties
        SET provider = ?, warranty_type = ?, coverage = ?, start_date = ?, expiry_date = ?,
            reference_no = ?, cost = ?, reminder_days = ?, notes = ?
      WHERE warranty_id = ?`,
    [
      data.provider,
      data.warranty_type,
      data.coverage,
      data.start_date,
      data.expiry_date,
      data.reference_no,
      data.cost,
      data.reminder_days,
      data.notes,
      warrantyId,
    ],
  )
  await recordAudit({
    assetId: String(row.finance_fixed_asset_id),
    action: "warranty_updated",
    userId: session.userId,
    userName: session.name,
    oldValue: { expiry_date: row.expiry_date, cost: row.cost },
    newValue: { expiry_date: data.expiry_date, cost: data.cost },
  })
  return { warranty_id: warrantyId }
}

export async function deleteWarranty(warrantyId: string, session: SessionPayload) {
  await ensureAssetLifecycleSchema()
  const current = (await query(`SELECT * FROM asset_warranties WHERE warranty_id = ? LIMIT 1`, [warrantyId]).catch(
    () => [],
  )) as any[]
  const row = current[0]
  if (!row) throw new AssetLifecycleError("Warranty not found.", 404)
  await query(`UPDATE asset_warranties SET archived_at = NOW() WHERE warranty_id = ?`, [warrantyId])
  await recordAudit({
    assetId: String(row.finance_fixed_asset_id),
    action: "warranty_removed",
    userId: session.userId,
    userName: session.name,
    oldValue: { warrantyId, provider: row.provider },
  })
  return { ok: true }
}

// ── Maintenance CRUD ─────────────────────────────────────────────────────────

export async function listMaintenance(params: { asset_id?: string | null; status?: string | null } = {}) {
  await ensureAssetLifecycleSchema()
  const where: string[] = ["1=1"]
  const args: any[] = []
  if (params.asset_id) {
    where.push("m.finance_fixed_asset_id = ?")
    args.push(params.asset_id)
  }
  if (params.status) {
    where.push("m.status = ?")
    args.push(params.status)
  }
  const rows = (await query(
    `SELECT m.*, fa.asset_name, fa.asset_category
       FROM asset_maintenance_records m
       LEFT JOIN fixed_assets fa ON fa.asset_id = m.finance_fixed_asset_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(m.next_service_date, m.scheduled_date, m.performed_date) DESC, m.id DESC
      LIMIT 2000`,
    args,
  ).catch(() => [])) as any[]
  return rows
}

export async function createMaintenance(input: MaintenanceInput, session: SessionPayload) {
  await ensureAssetLifecycleSchema()
  const data = validateMaintenanceInput(input, false)
  const asset = await requireAsset(data.finance_fixed_asset_id)

  // Idempotency: a repeated submit with the same key returns the original row
  // instead of inserting a duplicate maintenance record (which may carry a cost).
  if (data.idempotency_key) {
    const existing = (await query(
      `SELECT maintenance_id FROM asset_maintenance_records WHERE idempotency_key = ? LIMIT 1`,
      [data.idempotency_key],
    ).catch(() => [])) as any[]
    if (existing[0]) return { maintenance_id: String(existing[0].maintenance_id), idempotent: true }
  }

  const maintenanceId = await nextRecordId("MNT", { digits: 6, allowCustom: true })
  try {
    await query(
      `INSERT INTO asset_maintenance_records
         (maintenance_id, finance_fixed_asset_id, assignment_id, maintenance_type, status, scheduled_date,
          performed_date, vendor_party_id, vendor_name, cost, description, next_service_date, reminder_days,
          notes, idempotency_key, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        maintenanceId,
        data.finance_fixed_asset_id,
        data.assignment_id,
        data.maintenance_type,
        data.status,
        data.scheduled_date,
        data.performed_date,
        data.vendor_party_id,
        data.vendor_name,
        data.cost,
        data.description,
        data.next_service_date,
        data.reminder_days,
        data.notes,
        data.idempotency_key,
        session.userId,
      ],
    )
  } catch (e: any) {
    // Concurrent duplicate on the unique idempotency key — return the winner.
    if (data.idempotency_key && String(e?.code) === "ER_DUP_ENTRY") {
      const existing = (await query(
        `SELECT maintenance_id FROM asset_maintenance_records WHERE idempotency_key = ? LIMIT 1`,
        [data.idempotency_key],
      ).catch(() => [])) as any[]
      if (existing[0]) return { maintenance_id: String(existing[0].maintenance_id), idempotent: true }
    }
    throw e
  }

  await recordAudit({
    assetId: data.finance_fixed_asset_id,
    action: "maintenance_logged",
    userId: session.userId,
    userName: session.name,
    newValue: { maintenanceId, type: data.maintenance_type, status: data.status, cost: data.cost },
  })
  await notifyAssignee(data.finance_fixed_asset_id, {
    title: "Asset maintenance logged",
    body: `${data.maintenance_type} maintenance recorded for ${asset.asset_name ?? asset.asset_id}.`,
    entityId: maintenanceId,
  })
  return { maintenance_id: maintenanceId }
}

export async function updateMaintenance(maintenanceId: string, input: MaintenanceInput, session: SessionPayload) {
  await ensureAssetLifecycleSchema()
  const current = (await query(`SELECT * FROM asset_maintenance_records WHERE maintenance_id = ? LIMIT 1`, [
    maintenanceId,
  ]).catch(() => [])) as any[]
  const row = current[0]
  if (!row) throw new AssetLifecycleError("Maintenance record not found.", 404)

  const data = validateMaintenanceInput({ ...input, finance_fixed_asset_id: row.finance_fixed_asset_id }, true)
  await query(
    `UPDATE asset_maintenance_records
        SET maintenance_type = ?, status = ?, scheduled_date = ?, performed_date = ?, vendor_party_id = ?,
            vendor_name = ?, cost = ?, description = ?, next_service_date = ?, reminder_days = ?, notes = ?
      WHERE maintenance_id = ?`,
    [
      data.maintenance_type,
      data.status,
      data.scheduled_date,
      data.performed_date,
      data.vendor_party_id,
      data.vendor_name,
      data.cost,
      data.description,
      data.next_service_date,
      data.reminder_days,
      data.notes,
      maintenanceId,
    ],
  )
  await recordAudit({
    assetId: String(row.finance_fixed_asset_id),
    action: "maintenance_updated",
    userId: session.userId,
    userName: session.name,
    oldValue: { status: row.status, cost: row.cost },
    newValue: { status: data.status, cost: data.cost },
  })
  return { maintenance_id: maintenanceId }
}

/** All fixed assets, for the warranty/maintenance asset picker. */
export async function listAssetOptions(search?: string | null) {
  await ensureAssetLifecycleSchema()
  const args: any[] = []
  let where = ""
  if (search && search.trim()) {
    where = `WHERE asset_id LIKE ? OR asset_name LIKE ?`
    const like = `%${search.trim()}%`
    args.push(like, like)
  }
  const rows = (await query(
    `SELECT asset_id, asset_name, asset_category, status FROM fixed_assets ${where} ORDER BY asset_id DESC LIMIT 500`,
    args,
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    asset_id: String(r.asset_id),
    asset_name: r.asset_name ?? null,
    asset_category: r.asset_category ?? null,
    status: r.status ?? null,
  }))
}

// ── Expiry source feeds (consumed by lib/expiry/sources) ──────────────────────

/** Active warranties with a usable expiry date, for the unified expiry sweep. */
export async function fetchWarrantyExpiryRows() {
  await ensureAssetLifecycleSchema()
  return (await query(
    `SELECT w.warranty_id, w.finance_fixed_asset_id, w.provider, w.warranty_type, w.reference_no,
            w.start_date, w.expiry_date, w.reminder_days,
            fa.asset_name,
            (SELECT e.user_id FROM employee_asset_assignments a
               JOIN hr_employees e ON e.id = a.employee_id
              WHERE a.finance_fixed_asset_id = w.finance_fixed_asset_id
                AND a.status IN ('Assigned','Under Repair')
              ORDER BY a.id DESC LIMIT 1) AS owner_user_id
       FROM asset_warranties w
       LEFT JOIN fixed_assets fa ON fa.asset_id = w.finance_fixed_asset_id
      WHERE w.archived_at IS NULL AND w.expiry_date IS NOT NULL`,
  ).catch(() => [])) as any[]
}

/** Open maintenance records with an upcoming service date, for the sweep. */
export async function fetchMaintenanceDueRows() {
  await ensureAssetLifecycleSchema()
  return (await query(
    `SELECT m.maintenance_id, m.finance_fixed_asset_id, m.maintenance_type, m.next_service_date, m.reminder_days,
            fa.asset_name,
            (SELECT e.user_id FROM employee_asset_assignments a
               JOIN hr_employees e ON e.id = a.employee_id
              WHERE a.finance_fixed_asset_id = m.finance_fixed_asset_id
                AND a.status IN ('Assigned','Under Repair')
              ORDER BY a.id DESC LIMIT 1) AS owner_user_id
       FROM asset_maintenance_records m
       LEFT JOIN fixed_assets fa ON fa.asset_id = m.finance_fixed_asset_id
      WHERE m.next_service_date IS NOT NULL
        AND m.status IN (${OPEN_MAINTENANCE_STATUSES.map(() => "?").join(",")})`,
    OPEN_MAINTENANCE_STATUSES,
  ).catch(() => [])) as any[]
}
