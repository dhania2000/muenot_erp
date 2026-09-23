import "server-only"
import type { RowDataPacket } from "mysql2"
import { pool, query, withTransaction } from "@/lib/db"
import { ensureWhatsAppTable } from "@/lib/whatsapp"
import { ensureRegistrationSchema, withWhatsAppLock } from "@/lib/whatsapp-registration"

type Ownership = {
  id: number
  tenant_id: number | null
  tenant_status: string | null
  phone_number_id: string
  waba_id: string
  released_at: string | null
  connected_at: string
  registration_status: string | null
  has_credential: number
}
type OwnershipRow = Ownership & RowDataPacket

export class OwnershipReleaseError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

let auditEnsured: Promise<void> | undefined
async function ensureOwnershipAudit() {
  return auditEnsured ??= query(`CREATE TABLE IF NOT EXISTS marketing_whatsapp_ownership_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    integration_id INT UNSIGNED NOT NULL,
    previous_tenant_id INT UNSIGNED NULL,
    phone_number_id VARCHAR(191) NOT NULL,
    action VARCHAR(32) NOT NULL,
    actor_user_id INT UNSIGNED NULL,
    reason VARCHAR(500) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_wa_ownership_integration (integration_id),
    KEY idx_wa_ownership_phone (phone_number_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => undefined).catch(error => { auditEnsured = undefined; throw error })
}

/** Platform-only callers may inspect ownership metadata; credentials are never selected. */
export async function inspectWhatsAppPhoneOwnership(phoneNumberId: string) {
  if (!/^\d{1,191}$/.test(phoneNumberId)) throw new OwnershipReleaseError("Invalid phone number ID.", 400)
  await ensureWhatsAppTable()
  await ensureRegistrationSchema()
  // This is deliberately tenant-agnostic only behind the platform guard.
  const [rows] = await pool.query<OwnershipRow[]>(`SELECT i.id, i.tenant_id, t.status AS tenant_status,
      i.phone_number_id, i.waba_id, i.released_at, i.connected_at,
      r.registration_status, (i.access_token <> '') AS has_credential
    FROM marketing_whatsapp_integration i
    LEFT JOIN tenants t ON t.id=i.tenant_id
    LEFT JOIN marketing_whatsapp_registration r ON r.tenant_id=i.tenant_id AND r.connection_id=i.id
    WHERE i.phone_number_id=? ORDER BY i.released_at IS NULL DESC, i.id DESC`, [phoneNumberId])
  return rows.map(row => ({ integrationId: Number(row.id), ownerTenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    ownerTenantStatus: row.tenant_status, integrationStatus: row.released_at ? "released" : "assigned",
    registrationStatus: row.registration_status, hasCredential: Boolean(Number(row.has_credential)),
    connectedAt: row.connected_at, releasedAt: row.released_at, legacyUnmapped: row.tenant_id == null,
    recommendedAction: row.released_at ? "none" : row.tenant_status === "active" && Number(row.has_credential) !== 0
      ? "ask_owner_to_disconnect" : "super_admin_review_then_release" }))
}

async function release(integrationId: number, actorUserId: number | null, reason: string,
  expectedTenantId?: number, reviewed?: { phoneNumberId: string; ownerTenantId: number | null }) {
  if (!Number.isSafeInteger(integrationId) || integrationId <= 0) throw new OwnershipReleaseError("Invalid integration ID.", 400)
  const cleanReason = reason.trim()
  if (cleanReason.length < 10 || cleanReason.length > 500) throw new OwnershipReleaseError("Provide a 10–500 character release reason.", 400)
  await ensureWhatsAppTable()
  await ensureRegistrationSchema()
  await ensureOwnershipAudit()
  const [candidates] = await pool.query<Array<{ phone_number_id: string } & RowDataPacket>>(
    "SELECT phone_number_id FROM marketing_whatsapp_integration WHERE id=? LIMIT 1", [integrationId])
  const candidate = candidates[0]
  if (!candidate) throw new OwnershipReleaseError("Integration not found.", 404)
  return withWhatsAppLock("phone:" + candidate.phone_number_id, () => withTransaction(async connection => {
    const [rows] = await connection.query<OwnershipRow[]>(`SELECT i.id, i.tenant_id, t.status AS tenant_status,
        i.phone_number_id, i.waba_id, i.released_at, i.connected_at,
        r.registration_status, (i.access_token <> '') AS has_credential
      FROM marketing_whatsapp_integration i
      LEFT JOIN tenants t ON t.id=i.tenant_id
      LEFT JOIN marketing_whatsapp_registration r ON r.tenant_id=i.tenant_id AND r.connection_id=i.id
      WHERE i.id=? FOR UPDATE`, [integrationId])
    const row = rows[0]
    if (!row) throw new OwnershipReleaseError("Integration not found.", 404)
    if (expectedTenantId !== undefined && Number(row.tenant_id) !== expectedTenantId)
      throw new OwnershipReleaseError("Integration does not belong to this tenant.", 403)
    if (reviewed && (row.phone_number_id !== reviewed.phoneNumberId ||
      (row.tenant_id == null ? null : Number(row.tenant_id)) !== reviewed.ownerTenantId))
      throw new OwnershipReleaseError("Ownership changed since inspection. Inspect again before releasing.", 409)
    if (row.released_at) return { released: true, alreadyReleased: true }
    if (expectedTenantId === undefined && row.tenant_status === "active" && Number(row.has_credential) !== 0)
      throw new OwnershipReleaseError("Active tenant ownership cannot be released by support. Ask its admin to disconnect first.", 409)
    await connection.query("UPDATE marketing_whatsapp_integration SET released_at=UTC_TIMESTAMP(), access_token='' WHERE id=? AND released_at IS NULL", [integrationId])
    if (row.tenant_id != null) await connection.query(
      "UPDATE marketing_whatsapp_registration SET registration_status='released',cloud_api_registered=0,pin_encrypted=NULL WHERE tenant_id=? AND connection_id=?",
      [row.tenant_id, integrationId])
    await connection.query(`INSERT INTO marketing_whatsapp_ownership_events
      (integration_id,previous_tenant_id,phone_number_id,action,actor_user_id,reason)
      VALUES (?,?,?,?,?,?)`, [integrationId, row.tenant_id, row.phone_number_id,
      expectedTenantId === undefined ? "platform_release" : "tenant_disconnect", actorUserId, cleanReason])
    return { released: true, alreadyReleased: false }
  }))
}

/** Caller must pass an actor already authorized as platform_super_admin. */
export function releaseWhatsAppPhoneOwnership(integrationId: number,
  actor: { userId: number; platformRole: string }, reason: string,
  reviewed: { phoneNumberId: string; ownerTenantId: number | null }) {
  if (actor.platformRole !== "platform_super_admin") throw new OwnershipReleaseError("Platform super-admin privileges required.", 403)
  return release(integrationId, actor.userId, reason, undefined, reviewed)
}

/** Tenant-scoped normal disconnect releases rather than deleting historical rows. */
export function disconnectTenantWhatsAppIntegration(integrationId: number, tenantId: number, actorUserId: number | null) {
  return release(integrationId, actorUserId, "Disconnected by the owning tenant administrator.", tenantId)
}
