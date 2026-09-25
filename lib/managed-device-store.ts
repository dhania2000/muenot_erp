import "server-only"
/**
 * Managed-device policy + enrollments — server store (Spec25 · #214).
 * ---------------------------------------------------------------------------
 * A tenant may require sign-in from a MANAGED device. A device proves itself
 * with a VERIFIED DEVICE ASSERTION (a stateless, HMAC-signed token issued at
 * enrollment and bound to a stable device id) rather than a spoofable
 * user-agent. The crypto/decision core is lib/managed-device-core.ts; this
 * layer adds persistence (policy + enrollments), tenant scoping, liveness /
 * revocation checks, the audited emergency-access escape hatch, and audit logs.
 *
 * Revocation takes effect immediately: verification re-checks the enrollment
 * row's status on every sign-in, so a previously valid assertion is rejected
 * the instant its device is revoked — no waiting for the token to expire.
 *
 * Self-heals its schema at runtime; durable schema lives in
 * database/migrations/2027-01-17-spec25-geo-device-export.sql.
 */
import { query } from "@/lib/db"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { revokeAllSessionsForUser } from "@/lib/session-store"
import {
  type DeviceState,
  type ManagedDeviceDecision,
  DEFAULT_ASSERTION_TTL_SECONDS,
  evaluateManagedDevice,
  issueAssertion,
  newDeviceId,
  verifyAssertion,
} from "@/lib/managed-device-core"

function signingSecret(): string {
  return process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
}

export type ManagedDevicePolicyRecord = {
  tenantId: number
  required: boolean
  emergencyAccess: boolean
  updatedBy: number | null
  updatedAt: string | null
}

export type ManagedDevice = {
  id: number
  tenantId: number
  userId: number
  deviceId: string
  label: string
  status: "active" | "revoked"
  createdByName?: string | null
  lastSeenAt: string | null
  revokedAt: string | null
  createdAt: string
}

type PolicyRow = {
  tenant_id: number
  required: number
  emergency_access: number
  updated_by: number | null
  updated_at: string | null
}

type DeviceRow = {
  id: number
  tenant_id: number
  user_id: number
  device_id: string
  label: string
  status: "active" | "revoked"
  last_seen_at: string | null
  revoked_at: string | null
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`managed_device_policies\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`required\` TINYINT(1) NOT NULL DEFAULT 0,
      \`emergency_access\` TINYINT(1) NOT NULL DEFAULT 0,
      \`updated_by\` INT UNSIGNED DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`managed_device_enrollments\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`device_id\` VARCHAR(64) NOT NULL,
      \`label\` VARCHAR(190) NOT NULL,
      \`status\` ENUM('active','revoked') NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`last_seen_at\` DATETIME DEFAULT NULL,
      \`revoked_by\` INT UNSIGNED DEFAULT NULL,
      \`revoked_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_mde_tenant_device\` (\`tenant_id\`, \`device_id\`),
      KEY \`idx_mde_tenant_user\` (\`tenant_id\`, \`user_id\`),
      KEY \`idx_mde_tenant_status\` (\`tenant_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureManagedDeviceSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

function toDevice(row: DeviceRow): ManagedDevice {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    deviceId: row.device_id,
    label: row.label,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function getManagedDevicePolicy(tenantId: number | null): Promise<ManagedDevicePolicyRecord> {
  const empty: ManagedDevicePolicyRecord = {
    tenantId: tenantId ?? 0,
    required: false,
    emergencyAccess: false,
    updatedBy: null,
    updatedAt: null,
  }
  if (tenantId == null) return empty
  await ensureManagedDeviceSchema()
  const rows = await query<PolicyRow[]>(`SELECT * FROM \`managed_device_policies\` WHERE tenant_id = ? LIMIT 1`, [tenantId])
  if (rows.length === 0) return empty
  const r = rows[0]
  return {
    tenantId: Number(r.tenant_id),
    required: r.required === 1,
    emergencyAccess: r.emergency_access === 1,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }
}

export async function upsertManagedDevicePolicy(
  tenantId: number | null,
  actor: { userId: number; name?: string | null },
  input: { required?: unknown; emergencyAccess?: unknown },
): Promise<ManagedDevicePolicyRecord> {
  if (tenantId == null) throw new Error("A tenant context is required to configure a managed-device policy")
  await ensureManagedDeviceSchema()
  const required = Boolean(input.required)
  const emergencyAccess = Boolean(input.emergencyAccess)
  await query(
    `INSERT INTO \`managed_device_policies\` (tenant_id, required, emergency_access, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE required = VALUES(required), emergency_access = VALUES(emergency_access), updated_by = VALUES(updated_by)`,
    [tenantId, required ? 1 : 0, emergencyAccess ? 1 : 0, actor.userId],
  )
  await recordSecurityEvent({
    tenantId,
    category: "managed_device",
    action: "policy_updated",
    outcome: "updated",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    detail: { required, emergencyAccess },
  })
  return getManagedDevicePolicy(tenantId)
}

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

export async function listManagedDevices(tenantId: number | null, userId?: number): Promise<ManagedDevice[]> {
  if (tenantId == null) return []
  await ensureManagedDeviceSchema()
  const where = userId != null ? `WHERE tenant_id = ? AND user_id = ?` : `WHERE tenant_id = ?`
  const params = userId != null ? [tenantId, userId] : [tenantId]
  const rows = await query<DeviceRow[]>(
    `SELECT * FROM \`managed_device_enrollments\` ${where} ORDER BY created_at DESC LIMIT 500`,
    params,
  )
  return rows.map(toDevice)
}

export type EnrollResult = { device: ManagedDevice; assertion: string; expiresInSeconds: number }

/**
 * Enroll a device for a user and issue its verified device assertion. The token
 * is returned exactly once (the server stores no copy — it is stateless and
 * re-verified by signature) and must be presented on subsequent sign-ins.
 */
export async function enrollManagedDevice(
  tenantId: number | null,
  actor: { userId: number; name?: string | null },
  input: { userId?: number; label?: unknown; ttlSeconds?: number },
): Promise<EnrollResult> {
  if (tenantId == null) throw new Error("A tenant context is required to enroll a managed device")
  await ensureManagedDeviceSchema()
  const targetUserId = Number.isInteger(input.userId) ? Number(input.userId) : actor.userId
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 190) : "Managed device"
  const deviceId = newDeviceId()

  const res = await query<{ insertId: number }>(
    `INSERT INTO \`managed_device_enrollments\` (tenant_id, user_id, device_id, label, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [tenantId, targetUserId, deviceId, label, actor.userId],
  )
  const id = (res as any).insertId as number

  const ttlSeconds = input.ttlSeconds && input.ttlSeconds > 0 ? input.ttlSeconds : DEFAULT_ASSERTION_TTL_SECONDS
  const assertion = issueAssertion({ deviceId, tenantId, userId: targetUserId, ttlSeconds }, signingSecret())

  await recordSecurityEvent({
    tenantId,
    category: "managed_device",
    action: "device_enrolled",
    outcome: "created",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    detail: { deviceId, userId: targetUserId, label },
  })

  const rows = await query<DeviceRow[]>(`SELECT * FROM \`managed_device_enrollments\` WHERE id = ? LIMIT 1`, [id])
  return { device: toDevice(rows[0]), assertion, expiresInSeconds: ttlSeconds }
}

/**
 * Revoke an enrolled device. Immediately invalidates its assertion (the next
 * sign-in liveness check fails) and revokes the owner's active sessions so a
 * lost/compromised device cannot keep an existing session alive.
 */
export async function revokeManagedDevice(
  tenantId: number | null,
  actor: { userId: number; name?: string | null },
  deviceRowId: number,
): Promise<boolean> {
  if (tenantId == null) return false
  await ensureManagedDeviceSchema()
  const rows = await query<DeviceRow[]>(
    `SELECT * FROM \`managed_device_enrollments\` WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [deviceRowId, tenantId],
  )
  if (rows.length === 0) return false
  const device = rows[0]
  if (device.status === "revoked") return true

  await query(
    `UPDATE \`managed_device_enrollments\`
        SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?`,
    [actor.userId, deviceRowId, tenantId],
  )
  // Best-effort: drop the owner's live sessions so revocation is immediate.
  try {
    await revokeAllSessionsForUser(device.user_id)
  } catch {
    // never let session cleanup failure block the revocation
  }
  await recordSecurityEvent({
    tenantId,
    category: "managed_device",
    action: "device_revoked",
    outcome: "revoked",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    detail: { deviceId: device.device_id, userId: device.user_id, label: device.label },
  })
  return true
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Resolve the live device state for a presented assertion: verify signature +
 * expiry (core), then confirm the enrollment still exists, matches the user +
 * tenant, and is active. Also refreshes last_seen_at for a verified device.
 */
async function resolveDeviceState(
  tenantId: number,
  userId: number,
  assertion: unknown,
): Promise<{ state: DeviceState; deviceId: string | null }> {
  const verified = verifyAssertion(assertion, signingSecret())
  if (!verified.ok) return { state: "unknown", deviceId: null }
  const claims = verified.claims
  // The assertion must belong to THIS tenant + user — never trust cross-binding.
  if (claims.tenantId !== tenantId || claims.userId !== userId) return { state: "unknown", deviceId: null }

  const rows = await query<Pick<DeviceRow, "id" | "status">[]>(
    `SELECT id, status FROM \`managed_device_enrollments\` WHERE tenant_id = ? AND device_id = ? AND user_id = ? LIMIT 1`,
    [tenantId, claims.deviceId, userId],
  )
  if (rows.length === 0) return { state: "unknown", deviceId: claims.deviceId }
  if (rows[0].status === "revoked") return { state: "revoked", deviceId: claims.deviceId }

  await query(`UPDATE \`managed_device_enrollments\` SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`, [rows[0].id])
  return { state: "verified", deviceId: claims.deviceId }
}

export type ManagedDeviceEnforcementResult = {
  denied: boolean
  decision: ManagedDeviceDecision
  bypassed: boolean
  deviceId: string | null
}

/**
 * Enforce the tenant managed-device policy at sign-in. When required, the
 * caller must present a valid assertion for an active enrolled device. A denial
 * can be overridden by an audited emergency bypass (tenant emergency access ON
 * and caller authorized). Every block and bypass is recorded.
 */
export async function enforceManagedDevice(
  tenantId: number | null,
  params: {
    userId: number
    userName?: string | null
    userEmail?: string | null
    assertion?: unknown
    ip?: string | null
    emergencyAuthorized?: boolean
  },
): Promise<ManagedDeviceEnforcementResult> {
  const policy = await getManagedDevicePolicy(tenantId)
  if (!policy.required || tenantId == null) {
    return { denied: false, decision: { denied: false, reason: "policy_not_required" }, bypassed: false, deviceId: null }
  }

  const { state, deviceId } = await resolveDeviceState(tenantId, params.userId, params.assertion)
  const decision = evaluateManagedDevice({ required: true }, state)

  if (!decision.denied) {
    return { denied: false, decision, bypassed: false, deviceId }
  }

  if (policy.emergencyAccess && params.emergencyAuthorized) {
    await recordSecurityEvent({
      tenantId,
      category: "emergency_bypass",
      action: "managed_device_bypass",
      outcome: "bypassed",
      actorUserId: params.userId,
      actorName: params.userName ?? null,
      subjectEmail: params.userEmail ?? null,
      ipAddress: params.ip ?? null,
      detail: { reason: decision.reason, deviceId },
    })
    return { denied: false, decision, bypassed: true, deviceId }
  }

  await recordSecurityEvent({
    tenantId,
    category: "managed_device",
    action: "sign_in_blocked",
    outcome: "blocked",
    actorUserId: params.userId,
    actorName: params.userName ?? null,
    subjectEmail: params.userEmail ?? null,
    ipAddress: params.ip ?? null,
    detail: { reason: decision.reason, deviceId },
  })
  return { denied: true, decision, bypassed: false, deviceId }
}
