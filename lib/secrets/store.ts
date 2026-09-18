import "server-only"
/**
 * SPEC 38 — Secret management. Server orchestration (Phases 2 & 3).
 * ---------------------------------------------------------------------------
 * The one place the platform READS and WRITES managed secrets. It owns:
 *
 *   • ENCRYPTION AT REST — every value is stored only as an AES-256-GCM
 *     envelope (lib/secrets/crypto.ts). Plaintext never touches a column.
 *   • VERSIONING & ROTATION — each write appends a new version and retires the
 *     previous active one, so a rotation is auditable and reversible metadata
 *     survives. `last_rotated_at` drives the rotation-due status.
 *   • ACCESS AUDIT — every create/update/rotate/clear/access/view is appended
 *     to `secret_access_log` with the acting operator.
 *   • NO FRONTEND EXPOSURE — the only value that leaves this module toward a
 *     client is via `getSecretsOverview`, which returns the masked public
 *     projection asserted plaintext-free.
 *
 * Schema self-heals at runtime (the tenant-service pattern), and the whole
 * module degrades to env-only presence when the database is unreachable, so a
 * fresh preview still renders the inventory rather than throwing.
 */

import { query } from "@/lib/db"
import { SECRET_INVENTORY, getSecretDescriptor, isKnownSecret } from "./inventory"
import {
  assertNoPlaintextExposure,
  shapeAuditEvent,
  toPublicSecret,
  type PublicAuditEvent,
  type PublicSecret,
  type SecretAction,
  type SecretState,
} from "./model"
import { decryptSecret, encryptSecret, isEncryptionConfigured, keyFingerprint } from "./crypto"

export type SecretActor = { userId: number; email?: string | null }

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`managed_secrets\` (
      \`secret_key\` VARCHAR(120) NOT NULL,
      \`category\` VARCHAR(40) NOT NULL,
      \`current_version\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`key_fingerprint\` VARCHAR(24) DEFAULT NULL,
      \`last_rotated_at\` TIMESTAMP NULL DEFAULT NULL,
      \`last_accessed_at\` TIMESTAMP NULL DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`secret_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`managed_secret_versions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`secret_key\` VARCHAR(120) NOT NULL,
      \`version\` INT UNSIGNED NOT NULL,
      \`value_encrypted\` LONGTEXT NOT NULL,
      \`key_fingerprint\` VARCHAR(24) DEFAULT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`retired_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_secret_version\` (\`secret_key\`, \`version\`),
      KEY \`idx_secret_active\` (\`secret_key\`, \`is_active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`secret_access_log\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`secret_key\` VARCHAR(120) NOT NULL,
      \`action\` VARCHAR(20) NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(255) DEFAULT NULL,
      \`detail\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_log_secret\` (\`secret_key\`),
      KEY \`idx_log_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Register the reviewed inventory as metadata rows (never a value). Idempotent
  // and non-clobbering so operator rotation history is preserved across deploys.
  for (const d of SECRET_INVENTORY) {
    await query(
      `INSERT INTO \`managed_secrets\` (\`secret_key\`, \`category\`)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`category\` = VALUES(\`category\`)`,
      [d.key, d.category],
    )
  }
}

export async function ensureSecretSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Append an access-audit entry. Best-effort: auditing must never break a read. */
export async function recordSecretAccess(
  secretKey: string,
  action: SecretAction,
  actor: SecretActor | null,
  detail?: string,
): Promise<void> {
  try {
    await ensureSecretSchema()
    await query(
      `INSERT INTO \`secret_access_log\` (\`secret_key\`, \`action\`, \`actor_user_id\`, \`actor_email\`, \`detail\`)
       VALUES (?, ?, ?, ?, ?)`,
      [secretKey, action, actor?.userId ?? null, actor?.email ?? null, detail ? detail.slice(0, 255) : null],
    )
  } catch (err) {
    console.error("[v0] secret audit write failed", err)
  }
}

export async function listAccessLog(opts: { secretKey?: string; limit?: number } = {}): Promise<PublicAuditEvent[]> {
  await ensureSecretSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const rows = opts.secretKey
    ? await query<any[]>(
        "SELECT * FROM `secret_access_log` WHERE `secret_key` = ? ORDER BY `id` DESC LIMIT ?",
        [opts.secretKey, limit],
      )
    : await query<any[]>("SELECT * FROM `secret_access_log` ORDER BY `id` DESC LIMIT ?", [limit])
  return rows.map(shapeAuditEvent)
}

// ---------------------------------------------------------------------------
// State + overview (masked, safe to serialize)
// ---------------------------------------------------------------------------

type MetaRow = {
  secret_key: string
  current_version: number
  key_fingerprint: string | null
  last_rotated_at: string | null
  last_accessed_at: string | null
  updated_at: string | null
}

async function loadMetaByKey(): Promise<Map<string, MetaRow>> {
  const map = new Map<string, MetaRow>()
  try {
    await ensureSecretSchema()
    const rows = await query<MetaRow[]>(
      "SELECT `secret_key`, `current_version`, `key_fingerprint`, `last_rotated_at`, `last_accessed_at`, `updated_at` FROM `managed_secrets`",
    )
    for (const r of rows) map.set(r.secret_key, r)
  } catch (err) {
    console.error("[v0] secret store: metadata unavailable, degrading to env-only", err)
  }
  return map
}

/**
 * The effective, masked view of every inventoried secret: env-boundary presence
 * merged with stored-version metadata. Never carries a plaintext — the result
 * is asserted exposure-free before it is returned.
 */
export async function getSecretsOverview(): Promise<PublicSecret[]> {
  const meta = await loadMetaByKey()
  const now = new Date()
  const secrets = SECRET_INVENTORY.map((d) => {
    const m = meta.get(d.key)
    const version = m ? Number(m.current_version) : 0
    const state: SecretState = {
      envPresent: Boolean(process.env[d.envVar]),
      stored: version > 0,
      version,
      keyFingerprint: m?.key_fingerprint ?? null,
      lastRotatedAt: m?.last_rotated_at ?? null,
      updatedAt: m?.updated_at ?? null,
      lastAccessedAt: m?.last_accessed_at ?? null,
    }
    return toPublicSecret(d, state, now)
  })
  assertNoPlaintextExposure(secrets)
  return secrets
}

// ---------------------------------------------------------------------------
// Write / rotate / clear
// ---------------------------------------------------------------------------

/**
 * Store a new value for a secret. Every write is a new version: the previous
 * active version is retired and `last_rotated_at` advances, so setting and
 * rotating share one auditable path (the action label distinguishes them).
 */
export async function setSecret(
  key: string,
  value: string,
  actor: SecretActor,
  opts: { rotate?: boolean } = {},
): Promise<{ version: number }> {
  if (!isKnownSecret(key)) throw new Error(`Unknown secret "${key}"`)
  const descriptor = getSecretDescriptor(key)!
  const trimmed = String(value ?? "")
  if (trimmed === "") throw new Error("Secret value cannot be empty")
  if (!isEncryptionConfigured()) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is not configured — cannot store a secret at rest")
  }

  await ensureSecretSchema()
  const envelope = encryptSecret(trimmed)
  const fingerprint = keyFingerprint()

  const rows = await query<{ max_v: number | null }[]>(
    "SELECT MAX(`version`) AS max_v FROM `managed_secret_versions` WHERE `secret_key` = ?",
    [key],
  )
  const existingMax = Number(rows?.[0]?.max_v ?? 0)
  const nextVersion = existingMax + 1

  // Retire the current active version, then append and activate the new one.
  await query(
    "UPDATE `managed_secret_versions` SET `is_active` = 0, `retired_at` = CURRENT_TIMESTAMP WHERE `secret_key` = ? AND `is_active` = 1",
    [key],
  )
  await query(
    `INSERT INTO \`managed_secret_versions\` (\`secret_key\`, \`version\`, \`value_encrypted\`, \`key_fingerprint\`, \`is_active\`, \`created_by\`)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [key, nextVersion, envelope, fingerprint, actor.userId],
  )
  await query(
    `INSERT INTO \`managed_secrets\` (\`secret_key\`, \`category\`, \`current_version\`, \`key_fingerprint\`, \`last_rotated_at\`)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       \`current_version\` = VALUES(\`current_version\`),
       \`key_fingerprint\` = VALUES(\`key_fingerprint\`),
       \`last_rotated_at\` = CURRENT_TIMESTAMP`,
    [key, descriptor.category, nextVersion, fingerprint],
  )

  await recordSecretAccess(
    key,
    opts.rotate ? "rotate" : existingMax === 0 ? "create" : "update",
    actor,
    `version ${nextVersion}`,
  )
  return { version: nextVersion }
}

/** Rotate a secret to a new value. Thin alias over setSecret with the rotate label. */
export function rotateSecret(key: string, value: string, actor: SecretActor): Promise<{ version: number }> {
  return setSecret(key, value, actor, { rotate: true })
}

/**
 * Clear the stored value for a secret (does NOT touch the env binding). All
 * versions are retired and the active version drops to 0, so the managed store
 * no longer holds a value — the app falls back to the env boundary.
 */
export async function clearSecret(key: string, actor: SecretActor): Promise<void> {
  if (!isKnownSecret(key)) throw new Error(`Unknown secret "${key}"`)
  await ensureSecretSchema()
  await query(
    "UPDATE `managed_secret_versions` SET `is_active` = 0, `retired_at` = CURRENT_TIMESTAMP WHERE `secret_key` = ? AND `is_active` = 1",
    [key],
  )
  await query(
    "UPDATE `managed_secrets` SET `current_version` = 0, `key_fingerprint` = NULL WHERE `secret_key` = ?",
    [key],
  )
  await recordSecretAccess(key, "clear", actor)
}

// ---------------------------------------------------------------------------
// Server-only value resolution (NEVER serialize the result to a client)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective plaintext for a server-side consumer. Precedence
 * mirrors the config service: a deployment env value wins over a stored value.
 * The read is audited (best-effort). Returns null when neither layer holds a
 * value or when the stored envelope cannot be decrypted with the current key.
 *
 * MUST stay on the server — the return value is a live secret.
 */
export async function resolveSecret(key: string, actor?: SecretActor): Promise<string | null> {
  const descriptor = getSecretDescriptor(key)
  if (!descriptor) return null

  const fromEnv = process.env[descriptor.envVar]
  if (fromEnv) {
    await recordSecretAccess(key, "access", actor ?? null, "source=env")
    return fromEnv
  }

  try {
    await ensureSecretSchema()
    const rows = await query<{ value_encrypted: string }[]>(
      "SELECT `value_encrypted` FROM `managed_secret_versions` WHERE `secret_key` = ? AND `is_active` = 1 LIMIT 1",
      [key],
    )
    const envelope = rows?.[0]?.value_encrypted
    if (!envelope) return null
    const plaintext = decryptSecret(envelope)
    if (plaintext == null) return null
    await query("UPDATE `managed_secrets` SET `last_accessed_at` = CURRENT_TIMESTAMP WHERE `secret_key` = ?", [key])
    await recordSecretAccess(key, "access", actor ?? null, "source=stored")
    return plaintext
  } catch (err) {
    console.error("[v0] secret resolve failed", err)
    return null
  }
}
