import "server-only"
/**
 * Tenant integration secrets — SERVER orchestration.
 * ---------------------------------------------------------------------------
 * The one place a tenant's OWN integration credentials are read and written.
 * It composes three pieces built elsewhere:
 *
 *   • the pure model (lib/secrets/tenant-integrations.ts) — catalogue,
 *     validation, masked projection, rotation + rollback rules;
 *   • the vault provider abstraction (lib/secrets/providers) — WHERE a value
 *     physically lives (external AWS/Azure vault or the encrypted DB fallback);
 *   • the tenant isolation layer (lib/tenant-scope.ts) — every row is stamped
 *     and filtered by the caller's tenant, so one tenant can never read or
 *     mutate another's integration secrets.
 *
 * Guarantees carried here:
 *   - ENCRYPTION AT REST — the DB fallback only ever stores an AES-256-GCM
 *     envelope; plaintext never lands in a column. External vaults hold the
 *     value; we persist only their opaque version handle + ref.
 *   - FAIL-CLOSED FALLBACK — if a chosen external vault is unconfigured or
 *     unreachable at write time, the value is stored in the encrypted DB vault
 *     instead (never dropped, never left in plaintext) and health is recorded
 *     as down/degraded so the outage is visible and auditable.
 *   - VERSIONING / ROTATION / ROLLBACK — every write appends a version; a
 *     rollback reactivates a prior version. All are audited.
 *   - IDEMPOTENCY — a client Idempotency-Key collapses retries of the same
 *     write to a single version.
 *   - NO FRONTEND EXPOSURE — only the masked projection leaves this module
 *     toward a client; plaintext resolution is server-only + audited.
 */
import { query } from "@/lib/db"
import { currentTenantId, scopedWhere, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import { isEncryptionConfigured } from "@/lib/secrets/crypto"
import {
  type HealthState,
  type VaultKind,
  buildVaultProvider,
  classifyHealth,
  configuredDefaultVaultKind,
  getDatabaseVault,
  isVaultConfigured,
} from "@/lib/secrets/providers"
import {
  type IntegrationState,
  type PublicIntegration,
  type SecretVersionRow,
  TENANT_INTEGRATIONS,
  assertNoTenantSecretExposure,
  decideRollback,
  getIntegrationDescriptor,
  isKnownIntegration,
  isValidField,
  toPublicIntegration,
} from "@/lib/secrets/tenant-integrations"

export type IntegrationActor = { userId: number; email?: string | null }
export type TenantSecretAction = "set" | "rotate" | "rollback" | "test" | "access" | "clear"

// ---------------------------------------------------------------------------
// Schema (self-healing, tenant-scoped)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_integration_secrets\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`integration_key\` VARCHAR(64) NOT NULL,
      \`vault_kind\` VARCHAR(32) NOT NULL DEFAULT 'db',
      \`health_state\` VARCHAR(16) NOT NULL DEFAULT 'unknown',
      \`last_test_detail\` VARCHAR(500) DEFAULT NULL,
      \`last_tested_at\` TIMESTAMP NULL DEFAULT NULL,
      \`last_rotated_at\` TIMESTAMP NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tenant_integration\` (\`tenant_id\`, \`integration_key\`),
      KEY \`idx_tis_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_integration_secret_versions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`integration_key\` VARCHAR(64) NOT NULL,
      \`field_key\` VARCHAR(64) NOT NULL,
      \`version\` INT UNSIGNED NOT NULL,
      \`vault_kind\` VARCHAR(32) NOT NULL DEFAULT 'db',
      \`provider_version\` LONGTEXT NOT NULL,
      \`provider_ref\` VARCHAR(512) DEFAULT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`retired_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tis_version\` (\`tenant_id\`, \`integration_key\`, \`field_key\`, \`version\`),
      KEY \`idx_tisv_active\` (\`tenant_id\`, \`integration_key\`, \`field_key\`, \`is_active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_integration_secret_audit\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`integration_key\` VARCHAR(64) NOT NULL,
      \`field_key\` VARCHAR(64) DEFAULT NULL,
      \`action\` VARCHAR(20) NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(255) DEFAULT NULL,
      \`detail\` VARCHAR(500) DEFAULT NULL,
      \`idempotency_key\` VARCHAR(200) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tisa_scope\` (\`tenant_id\`, \`integration_key\`),
      KEY \`idx_tisa_created\` (\`tenant_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_integration_secret_idempotency\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`idem_key\` VARCHAR(200) NOT NULL,
      \`action\` VARCHAR(20) NOT NULL,
      \`integration_key\` VARCHAR(64) NOT NULL,
      \`field_key\` VARCHAR(64) DEFAULT NULL,
      \`result_version\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tis_idem\` (\`tenant_id\`, \`idem_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureTenantIntegrationSchema(): Promise<void> {
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

/** Append an audit entry. Best-effort: auditing must never break the action. */
async function recordAudit(entry: {
  integrationKey: string
  fieldKey?: string | null
  action: TenantSecretAction
  actor: IntegrationActor | null
  detail?: string | null
  idempotencyKey?: string | null
}): Promise<void> {
  try {
    await tenantInsert("tenant_integration_secret_audit", {
      integration_key: entry.integrationKey,
      field_key: entry.fieldKey ?? null,
      action: entry.action,
      actor_user_id: entry.actor?.userId ?? null,
      actor_email: entry.actor?.email ?? null,
      detail: entry.detail ? String(entry.detail).slice(0, 500) : null,
      idempotency_key: entry.idempotencyKey ?? null,
    })
  } catch (err) {
    console.error("[v0] tenant integration audit write failed", err)
  }
}

export type PublicIntegrationAuditEvent = {
  id: number
  integrationKey: string
  fieldKey: string | null
  action: string
  actorEmail: string | null
  detail: string | null
  at: string
}

/** Audit history for the current tenant, optionally filtered to one integration. */
export async function getIntegrationAudit(opts: {
  integrationKey?: string
  limit?: number
} = {}): Promise<PublicIntegrationAuditEvent[]> {
  await ensureTenantIntegrationSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const filter = opts.integrationKey ? "integration_key = ?" : ""
  const params = opts.integrationKey ? [opts.integrationKey] : []
  const { where, params: scopedParams } = scopedWhere("tenant_integration_secret_audit", filter, params)
  const rows = await query<any[]>(
    `SELECT * FROM \`tenant_integration_secret_audit\` ${where} ORDER BY \`id\` DESC LIMIT ${limit}`,
    scopedParams,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    integrationKey: r.integration_key,
    fieldKey: r.field_key ?? null,
    action: r.action,
    actorEmail: r.actor_email ?? null,
    detail: r.detail ?? null,
    at: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Vault ref + provider resolution
// ---------------------------------------------------------------------------

function vaultRef(tenantId: number, integrationKey: string, fieldKey: string): string {
  return `muenot/t${tenantId}/${integrationKey}/${fieldKey}`
}

/**
 * Resolve the vault a write should target. An explicit external choice wins
 * when it is configured; otherwise the deployment default external vault when
 * configured; otherwise the always-available encrypted DB vault.
 */
function resolveTargetKind(requested: VaultKind | null): VaultKind {
  if (requested && requested !== "db") {
    return isVaultConfigured(requested) ? requested : "db"
  }
  if (requested === "db") return "db"
  const def = configuredDefaultVaultKind()
  if (def && isVaultConfigured(def)) return def
  return "db"
}

type WriteResult = {
  vaultKind: VaultKind
  providerVersion: string
  providerRef: string | null
  health: HealthState
  detail: string | null
}

/**
 * Physically store `value`. For the DB vault the returned `providerVersion` is
 * the ciphertext envelope the caller persists. For an external vault we push
 * the value and persist only the opaque version handle + ref. On external
 * outage we FALL BACK to the encrypted DB vault so the secret is never dropped
 * or left in plaintext, and surface a degraded/down health.
 */
async function writeToVault(
  tenantId: number,
  integrationKey: string,
  fieldKey: string,
  value: string,
  requested: VaultKind | null,
): Promise<WriteResult> {
  const target = resolveTargetKind(requested)

  if (target === "db") {
    const env = await getDatabaseVault().putSecret("", value)
    return { vaultKind: "db", providerVersion: env.providerVersion, providerRef: null, health: "healthy", detail: null }
  }

  const provider = buildVaultProvider(target)
  const ref = vaultRef(tenantId, integrationKey, fieldKey)
  if (!provider) {
    // Should not happen (target only chosen when configured) — fail closed to DB.
    const env = await getDatabaseVault().putSecret("", value)
    return { vaultKind: "db", providerVersion: env.providerVersion, providerRef: null, health: "down", detail: `${target} not constructible` }
  }
  try {
    const out = await provider.putSecret(ref, value)
    return { vaultKind: target, providerVersion: out.providerVersion, providerRef: ref, health: "healthy", detail: null }
  } catch (err) {
    const probe = await provider.probe().catch(() => ({ ok: false }))
    const health = classifyHealth(probe)
    const env = await getDatabaseVault().putSecret("", value)
    return {
      vaultKind: "db",
      providerVersion: env.providerVersion,
      providerRef: null,
      health: health === "healthy" ? "down" : health,
      detail: `external write failed, stored in encrypted DB vault: ${(err as Error).message}`,
    }
  }
}

/** Read the plaintext for a persisted version row. Rejects when unavailable. */
async function readFromVault(row: {
  vault_kind: string
  provider_version: string
  provider_ref: string | null
}): Promise<string> {
  const kind = row.vault_kind as VaultKind
  if (kind === "db") {
    const out = await getDatabaseVault().getSecret("", row.provider_version)
    return out.value
  }
  const provider = buildVaultProvider(kind)
  if (!provider) throw new Error(`Vault ${kind} is not configured; cannot read secret`)
  const out = await provider.getSecret(row.provider_ref ?? "", row.provider_version)
  return out.value
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** Returns the previously-stored version for this idem key, or null. */
async function lookupIdempotent(idemKey: string): Promise<number | null> {
  const { where, params } = scopedWhere("tenant_integration_secret_idempotency", "idem_key = ?", [idemKey])
  const rows = await query<any[]>(
    `SELECT result_version FROM \`tenant_integration_secret_idempotency\` ${where} LIMIT 1`,
    params,
  )
  if (!rows.length) return null
  return rows[0].result_version == null ? null : Number(rows[0].result_version)
}

async function recordIdempotent(
  idemKey: string,
  action: TenantSecretAction,
  integrationKey: string,
  fieldKey: string,
  version: number,
): Promise<void> {
  const tenantId = currentTenantId()
  await query(
    `INSERT INTO \`tenant_integration_secret_idempotency\`
       (\`tenant_id\`, \`idem_key\`, \`action\`, \`integration_key\`, \`field_key\`, \`result_version\`)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`result_version\` = \`result_version\``,
    [tenantId, idemKey, action, integrationKey, fieldKey, version],
  )
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

async function loadVersionRows(integrationKey: string, fieldKey: string): Promise<any[]> {
  const { where, params } = scopedWhere(
    "tenant_integration_secret_versions",
    "integration_key = ? AND field_key = ?",
    [integrationKey, fieldKey],
  )
  return query<any[]>(
    `SELECT * FROM \`tenant_integration_secret_versions\` ${where} ORDER BY \`version\` ASC`,
    params,
  )
}

function toVersionRow(r: any): SecretVersionRow {
  return {
    version: Number(r.version),
    vaultKind: r.vault_kind as VaultKind,
    active: !!r.is_active,
    createdAt: r.created_at,
    retiredAt: r.retired_at ?? null,
  }
}

async function upsertIntegrationRow(
  integrationKey: string,
  patch: { vaultKind?: VaultKind; health?: HealthState; detail?: string | null; rotated?: boolean; tested?: boolean },
): Promise<void> {
  const tenantId = currentTenantId()
  const cols: string[] = ["tenant_id", "integration_key"]
  const vals: any[] = [tenantId, integrationKey]
  const updates: string[] = []
  if (patch.vaultKind) {
    cols.push("vault_kind")
    vals.push(patch.vaultKind)
    updates.push("`vault_kind` = VALUES(`vault_kind`)")
  }
  if (patch.health) {
    cols.push("health_state")
    vals.push(patch.health)
    updates.push("`health_state` = VALUES(`health_state`)")
  }
  if (patch.detail !== undefined) {
    cols.push("last_test_detail")
    vals.push(patch.detail)
    updates.push("`last_test_detail` = VALUES(`last_test_detail`)")
  }
  if (patch.rotated) updates.push("`last_rotated_at` = CURRENT_TIMESTAMP")
  if (patch.tested) updates.push("`last_tested_at` = CURRENT_TIMESTAMP")
  const placeholders = cols.map(() => "?").join(", ")
  await query(
    `INSERT INTO \`tenant_integration_secrets\` (${cols.map((c) => `\`${c}\``).join(", ")})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates.length ? updates.join(", ") : "`updated_at` = CURRENT_TIMESTAMP"}`,
    vals,
  )
}

// ---------------------------------------------------------------------------
// Write / rotate
// ---------------------------------------------------------------------------

export type WriteOutcome = { version: number; vaultKind: VaultKind; health: HealthState; deduped: boolean }

async function writeVersion(
  action: "set" | "rotate",
  input: {
    integrationKey: string
    fieldKey: string
    value: string
    vaultChoice: VaultKind | null
    actor: IntegrationActor
    idempotencyKey?: string | null
  },
): Promise<WriteOutcome> {
  const { integrationKey, fieldKey, value, vaultChoice, actor, idempotencyKey } = input
  if (!isKnownIntegration(integrationKey)) throw new Error(`Unknown integration "${integrationKey}"`)
  if (!isValidField(integrationKey, fieldKey)) throw new Error(`Invalid field "${fieldKey}" for "${integrationKey}"`)
  const trimmed = String(value ?? "")
  if (trimmed === "") throw new Error("Secret value cannot be empty")
  if (!isEncryptionConfigured()) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is not configured — cannot store a secret at rest")
  }

  await ensureTenantIntegrationSchema()
  const tenantId = currentTenantId()

  if (idempotencyKey) {
    const existing = await lookupIdempotent(idempotencyKey)
    if (existing != null) {
      const row = (await loadVersionRows(integrationKey, fieldKey)).find((r) => Number(r.version) === existing)
      return {
        version: existing,
        vaultKind: (row?.vault_kind as VaultKind) ?? "db",
        health: "healthy",
        deduped: true,
      }
    }
  }

  const existingRows = await loadVersionRows(integrationKey, fieldKey)
  const maxVersion = existingRows.reduce((m, r) => Math.max(m, Number(r.version)), 0)
  const version = maxVersion + 1

  const written = await writeToVault(tenantId, integrationKey, fieldKey, trimmed, vaultChoice)

  // Retire the current active version for this field, then append + activate.
  await tenantUpdate(
    "tenant_integration_secret_versions",
    { is_active: 0, retired_at: new Date() },
    "integration_key = ? AND field_key = ? AND is_active = 1",
    [integrationKey, fieldKey],
  )
  await tenantInsert("tenant_integration_secret_versions", {
    integration_key: integrationKey,
    field_key: fieldKey,
    version,
    vault_kind: written.vaultKind,
    provider_version: written.providerVersion,
    provider_ref: written.providerRef,
    is_active: 1,
    created_by: actor.userId,
  })

  await upsertIntegrationRow(integrationKey, {
    vaultKind: written.vaultKind,
    health: written.health,
    detail: written.detail,
    rotated: true,
  })

  if (idempotencyKey) await recordIdempotent(idempotencyKey, action, integrationKey, fieldKey, version)

  await recordAudit({
    integrationKey,
    fieldKey,
    action,
    actor,
    detail: `version ${version} → ${written.vaultKind}${written.detail ? ` (${written.detail})` : ""}`,
    idempotencyKey,
  })

  return { version, vaultKind: written.vaultKind, health: written.health, deduped: false }
}

export function setIntegrationSecret(input: {
  integrationKey: string
  fieldKey: string
  value: string
  vaultChoice: VaultKind | null
  actor: IntegrationActor
  idempotencyKey?: string | null
}): Promise<WriteOutcome> {
  return writeVersion("set", input)
}

export function rotateIntegrationSecret(input: {
  integrationKey: string
  fieldKey: string
  value: string
  vaultChoice: VaultKind | null
  actor: IntegrationActor
  idempotencyKey?: string | null
}): Promise<WriteOutcome> {
  return writeVersion("rotate", input)
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll a field back to a prior version by REACTIVATING it (append-only history
 * is preserved; no ciphertext is rewritten). Validated by the pure
 * `decideRollback` over the known versions.
 */
export async function rollbackIntegrationSecret(input: {
  integrationKey: string
  fieldKey: string
  targetVersion: number
  actor: IntegrationActor
  idempotencyKey?: string | null
}): Promise<{ version: number; fromVersion: number | null; deduped: boolean }> {
  const { integrationKey, fieldKey, targetVersion, actor, idempotencyKey } = input
  if (!isKnownIntegration(integrationKey)) throw new Error(`Unknown integration "${integrationKey}"`)
  if (!isValidField(integrationKey, fieldKey)) throw new Error(`Invalid field "${fieldKey}" for "${integrationKey}"`)
  await ensureTenantIntegrationSchema()

  if (idempotencyKey) {
    const existing = await lookupIdempotent(idempotencyKey)
    if (existing != null) return { version: existing, fromVersion: null, deduped: true }
  }

  const rows = await loadVersionRows(integrationKey, fieldKey)
  const decision = decideRollback(rows.map(toVersionRow), targetVersion)
  if (!decision.ok) throw new Error(decision.reason)

  await tenantUpdate(
    "tenant_integration_secret_versions",
    { is_active: 0, retired_at: new Date() },
    "integration_key = ? AND field_key = ? AND is_active = 1",
    [integrationKey, fieldKey],
  )
  await tenantUpdate(
    "tenant_integration_secret_versions",
    { is_active: 1, retired_at: null },
    "integration_key = ? AND field_key = ? AND version = ?",
    [integrationKey, fieldKey, targetVersion],
  )
  // Reflect the reactivated version's vault on the integration row.
  const restored = rows.find((r) => Number(r.version) === targetVersion)
  await upsertIntegrationRow(integrationKey, {
    vaultKind: (restored?.vault_kind as VaultKind) ?? undefined,
    rotated: true,
  })

  if (idempotencyKey) await recordIdempotent(idempotencyKey, "rollback", integrationKey, fieldKey, targetVersion)
  await recordAudit({
    integrationKey,
    fieldKey,
    action: "rollback",
    actor,
    detail: `rolled back ${decision.fromVersion ?? "none"} → ${targetVersion}`,
    idempotencyKey,
  })

  return { version: targetVersion, fromVersion: decision.fromVersion, deduped: false }
}

// ---------------------------------------------------------------------------
// Test connection / health
// ---------------------------------------------------------------------------

/**
 * Probe the vault an integration uses (or a requested one) WITHOUT moving any
 * secret material, persist the resulting health, and audit the test. The DB
 * vault has no network dependency so it is healthy whenever encryption is
 * configured.
 */
export async function testIntegrationConnection(input: {
  integrationKey: string
  vaultChoice?: VaultKind | null
  actor: IntegrationActor
}): Promise<{ vaultKind: VaultKind; health: HealthState; detail: string | null }> {
  const { integrationKey, vaultChoice, actor } = input
  if (!isKnownIntegration(integrationKey)) throw new Error(`Unknown integration "${integrationKey}"`)
  await ensureTenantIntegrationSchema()

  const kind = resolveTargetKind(vaultChoice ?? null)
  const provider = buildVaultProvider(kind) ?? getDatabaseVault()
  const probe = await provider.probe().catch((err) => ({ ok: false, detail: (err as Error).message }))
  const health = classifyHealth(probe)
  const detail = probe.ok ? null : (probe.detail ?? "probe failed")

  await upsertIntegrationRow(integrationKey, { vaultKind: kind, health, detail, tested: true })
  await recordAudit({
    integrationKey,
    action: "test",
    actor,
    detail: `vault=${kind} health=${health}${detail ? ` (${detail})` : ""}`,
  })
  return { vaultKind: kind, health, detail }
}

// ---------------------------------------------------------------------------
// Overview (masked) + server-only resolution
// ---------------------------------------------------------------------------

/** Masked, plaintext-free overview of every catalogue integration for the tenant. */
export async function getIntegrationsOverview(now: Date = new Date()): Promise<PublicIntegration[]> {
  await ensureTenantIntegrationSchema()

  const integScope = scopedWhere("tenant_integration_secrets", "")
  const integRows = await query<any[]>(
    `SELECT * FROM \`tenant_integration_secrets\` ${integScope.where}`,
    integScope.params,
  )
  const integByKey = new Map(integRows.map((r) => [r.integration_key, r]))

  const versScope = scopedWhere("tenant_integration_secret_versions", "is_active = 1")
  const activeRows = await query<any[]>(
    `SELECT integration_key, field_key, version, vault_kind, created_at
       FROM \`tenant_integration_secret_versions\` ${versScope.where}`,
    versScope.params,
  )
  const activeByField = new Map<string, any>()
  for (const r of activeRows) activeByField.set(`${r.integration_key}:${r.field_key}`, r)

  const result = TENANT_INTEGRATIONS.map((descriptor) => {
    const integ = integByKey.get(descriptor.key)
    const fieldStates: IntegrationState["fields"] = {}
    for (const f of descriptor.fields) {
      const active = activeByField.get(`${descriptor.key}:${f.key}`)
      fieldStates[f.key] = {
        present: !!active,
        version: active ? Number(active.version) : null,
        vaultKind: active ? (active.vault_kind as VaultKind) : null,
        lastRotatedAt: integ?.last_rotated_at ?? null,
      }
    }
    const state: IntegrationState = {
      vaultKind: (integ?.vault_kind as VaultKind) ?? "db",
      health: (integ?.health_state as HealthState) ?? "unknown",
      lastTestedAt: integ?.last_tested_at ?? null,
      fields: fieldStates,
    }
    return toPublicIntegration(descriptor, state, now)
  })

  assertNoTenantSecretExposure(result)
  return result
}

/**
 * Resolve the effective plaintext of an integration field for a SERVER-side
 * consumer (e.g. calling the tenant's own Stripe/SMTP). Audited. Returns null
 * when unset or when the active version's vault cannot be read (fail-closed).
 *
 * MUST stay on the server — the return value is a live tenant secret.
 */
export async function resolveIntegrationSecret(
  integrationKey: string,
  fieldKey: string,
  actor?: IntegrationActor,
): Promise<string | null> {
  if (!isKnownIntegration(integrationKey)) return null
  await ensureTenantIntegrationSchema()
  const { where, params } = scopedWhere(
    "tenant_integration_secret_versions",
    "integration_key = ? AND field_key = ? AND is_active = 1",
    [integrationKey, fieldKey],
  )
  const rows = await query<any[]>(
    `SELECT vault_kind, provider_version, provider_ref FROM \`tenant_integration_secret_versions\` ${where} LIMIT 1`,
    params,
  )
  if (!rows.length) return null
  try {
    const value = await readFromVault(rows[0])
    await recordAudit({ integrationKey, fieldKey, action: "access", actor: actor ?? null, detail: `source=${rows[0].vault_kind}` })
    return value
  } catch (err) {
    await recordAudit({
      integrationKey,
      fieldKey,
      action: "access",
      actor: actor ?? null,
      detail: `read failed (fail-closed): ${(err as Error).message}`,
    })
    return null
  }
}
