import "server-only"
/**
 * Integration marketplace — SERVER orchestration (Spec 15, #88-89).
 * ---------------------------------------------------------------------------
 * The one place a tenant's connector installs and credentials are read and
 * written. It composes pieces built elsewhere and NEVER re-implements them:
 *
 *   • the pure model (lib/marketplace/connectors.ts) — catalogue, common
 *     manifest, scope + credential validation, lifecycle state machine, masked
 *     projection, permission review, idempotency-key derivation;
 *   • the reviewed adapters (lib/marketplace/adapters.ts) — the ONLY code that
 *     acts for a connector, selected strictly by a validated catalogue key so
 *     tenant input can never become executable connector logic;
 *   • the secrets crypto (lib/secrets/crypto.ts) — the SAME AES-256-GCM
 *     envelope the secrets vault uses, reused for credentials at rest rather
 *     than inventing a second scheme;
 *   • the tenant isolation layer (lib/tenant-scope.ts) — every row is stamped
 *     and filtered by the caller's tenant.
 *
 * Guarantees carried here:
 *   - TENANT ISOLATION — all access goes through tenant-scope helpers; a
 *     connector install or credential is invisible and immutable across tenants.
 *   - ENCRYPTION AT REST — credential columns only ever hold a ciphertext
 *     envelope; plaintext never lands in the DB and never leaves toward a client.
 *   - INSTALL ROLLBACK — an install is atomic in effect: if credential storage
 *     or the adapter readiness probe fails, every partial write from THIS
 *     attempt is undone and no install is recorded.
 *   - SECRET REVOCATION — disconnect revokes every active credential so it can
 *     no longer be resolved, while preserving the audit history.
 *   - IDEMPOTENCY — a client Idempotency-Key collapses retries of a write to a
 *     single effect.
 *   - AUDIT — every lifecycle action and credential access is recorded.
 */
import { query } from "@/lib/db"
import { currentTenantId, scopedWhere, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secrets/crypto"
import { type HealthState, classifyHealth } from "@/lib/secrets/providers/types"
import { getAdapter } from "@/lib/marketplace/adapters"
import {
  CONNECTORS,
  type ConnectorAction,
  type ConnectorState,
  type InstallStatus,
  type PublicConnector,
  type ScopeReview,
  assertNoConnectorSecretExposure,
  canTransition,
  getConnector,
  isKnownConnector,
  resolveGrantedScopes,
  reviewConnectorPermissions,
  toPublicConnector,
  validateConnectorCredentials,
} from "@/lib/marketplace/connectors"

export type ConnectorActor = { userId: number; email?: string | null }
export type ConnectorAuditAction = ConnectorAction | "install_failed" | "reconnect_failed" | "access"

// ---------------------------------------------------------------------------
// Schema (self-healing, tenant-scoped)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_connector_installations\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`connector_key\` VARCHAR(64) NOT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'not_installed',
      \`granted_scopes\` TEXT DEFAULT NULL,
      \`health_state\` VARCHAR(16) NOT NULL DEFAULT 'unknown',
      \`last_error\` VARCHAR(500) DEFAULT NULL,
      \`installed_by\` INT UNSIGNED DEFAULT NULL,
      \`installed_at\` TIMESTAMP NULL DEFAULT NULL,
      \`last_connected_at\` TIMESTAMP NULL DEFAULT NULL,
      \`last_health_at\` TIMESTAMP NULL DEFAULT NULL,
      \`disconnected_at\` TIMESTAMP NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tenant_connector\` (\`tenant_id\`, \`connector_key\`),
      KEY \`idx_tci_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_connector_credentials\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`connector_key\` VARCHAR(64) NOT NULL,
      \`field_key\` VARCHAR(64) NOT NULL,
      \`ciphertext\` LONGTEXT NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`revoked_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tcc_active\` (\`tenant_id\`, \`connector_key\`, \`field_key\`, \`is_active\`),
      KEY \`idx_tcc_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_connector_audit\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`connector_key\` VARCHAR(64) NOT NULL,
      \`action\` VARCHAR(24) NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(255) DEFAULT NULL,
      \`detail\` VARCHAR(500) DEFAULT NULL,
      \`idempotency_key\` VARCHAR(200) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tca_scope\` (\`tenant_id\`, \`connector_key\`),
      KEY \`idx_tca_created\` (\`tenant_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_connector_idempotency\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`idem_key\` VARCHAR(200) NOT NULL,
      \`action\` VARCHAR(24) NOT NULL,
      \`connector_key\` VARCHAR(64) NOT NULL,
      \`result_status\` VARCHAR(16) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tc_idem\` (\`tenant_id\`, \`idem_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureConnectorSchema(): Promise<void> {
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

async function recordAudit(entry: {
  connectorKey: string
  action: ConnectorAuditAction
  actor: ConnectorActor | null
  detail?: string | null
  idempotencyKey?: string | null
}): Promise<void> {
  try {
    await tenantInsert("tenant_connector_audit", {
      connector_key: entry.connectorKey,
      action: entry.action,
      actor_user_id: entry.actor?.userId ?? null,
      actor_email: entry.actor?.email ?? null,
      detail: entry.detail ? String(entry.detail).slice(0, 500) : null,
      idempotency_key: entry.idempotencyKey ?? null,
    })
  } catch (err) {
    console.error("[v0] connector audit write failed", err)
  }
}

export type PublicConnectorAuditEvent = {
  id: number
  connectorKey: string
  action: string
  actorEmail: string | null
  detail: string | null
  at: string
}

/** Audit history for the current tenant, optionally filtered to one connector. */
export async function getConnectorAudit(
  opts: { connectorKey?: string; limit?: number } = {},
): Promise<PublicConnectorAuditEvent[]> {
  await ensureConnectorSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const filter = opts.connectorKey ? "connector_key = ?" : ""
  const params = opts.connectorKey ? [opts.connectorKey] : []
  const { where, params: scopedParams } = scopedWhere("tenant_connector_audit", filter, params)
  const rows = await query<any[]>(
    `SELECT * FROM \`tenant_connector_audit\` ${where} ORDER BY \`id\` DESC LIMIT ${limit}`,
    scopedParams,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    connectorKey: r.connector_key,
    action: r.action,
    actorEmail: r.actor_email ?? null,
    detail: r.detail ?? null,
    at: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

async function lookupIdempotent(idemKey: string): Promise<string | null> {
  const { where, params } = scopedWhere("tenant_connector_idempotency", "idem_key = ?", [idemKey])
  const rows = await query<any[]>(
    `SELECT result_status FROM \`tenant_connector_idempotency\` ${where} LIMIT 1`,
    params,
  )
  if (!rows.length) return null
  return rows[0].result_status == null ? "" : String(rows[0].result_status)
}

async function recordIdempotent(
  idemKey: string,
  action: ConnectorAction,
  connectorKey: string,
  status: InstallStatus,
): Promise<void> {
  const tenantId = currentTenantId()
  await query(
    `INSERT INTO \`tenant_connector_idempotency\`
       (\`tenant_id\`, \`idem_key\`, \`action\`, \`connector_key\`, \`result_status\`)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`result_status\` = \`result_status\``,
    [tenantId, idemKey, action, connectorKey, status],
  )
}

// ---------------------------------------------------------------------------
// Installation + credential access
// ---------------------------------------------------------------------------

type InstallationRow = {
  connector_key: string
  status: string
  granted_scopes: string | null
  health_state: string
  last_error: string | null
  installed_at: string | null
  last_connected_at: string | null
  last_health_at: string | null
  disconnected_at: string | null
}

function parseScopes(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : []
  } catch {
    return []
  }
}

async function loadInstallation(connectorKey: string): Promise<InstallationRow | null> {
  const { where, params } = scopedWhere("tenant_connector_installations", "connector_key = ?", [connectorKey])
  const rows = await query<any[]>(
    `SELECT * FROM \`tenant_connector_installations\` ${where} LIMIT 1`,
    params,
  )
  return (rows[0] as InstallationRow) ?? null
}

function currentStatus(row: InstallationRow | null): InstallStatus {
  const s = row?.status
  return s === "installed" || s === "disconnected" ? s : "not_installed"
}

/** Active (non-revoked) credential field keys for a connector, scoped to tenant. */
async function loadActiveCredentialFields(connectorKey: string): Promise<string[]> {
  const { where, params } = scopedWhere(
    "tenant_connector_credentials",
    "connector_key = ? AND is_active = 1",
    [connectorKey],
  )
  const rows = await query<any[]>(
    `SELECT DISTINCT field_key FROM \`tenant_connector_credentials\` ${where}`,
    params,
  )
  return rows.map((r) => String(r.field_key))
}

/**
 * Decrypt the active credentials for a connector into a plain map. SERVER-ONLY
 * and never returned toward a client — only the reviewed adapters consume this.
 */
async function loadActiveCredentials(connectorKey: string): Promise<Record<string, string>> {
  const { where, params } = scopedWhere(
    "tenant_connector_credentials",
    "connector_key = ? AND is_active = 1",
    [connectorKey],
  )
  const rows = await query<any[]>(
    `SELECT field_key, ciphertext FROM \`tenant_connector_credentials\` ${where} ORDER BY \`id\` ASC`,
    params,
  )
  const out: Record<string, string> = {}
  for (const r of rows) {
    const plain = decryptSecret(r.ciphertext)
    if (plain != null) out[String(r.field_key)] = plain
  }
  return out
}

/** Revoke every active credential for a connector (secret revocation). */
async function revokeActiveCredentials(connectorKey: string): Promise<number> {
  return tenantUpdate(
    "tenant_connector_credentials",
    { is_active: 0, revoked_at: new Date() },
    "connector_key = ? AND is_active = 1",
    [connectorKey],
  )
}

// ---------------------------------------------------------------------------
// Overview + permission review (read side)
// ---------------------------------------------------------------------------

async function buildState(connectorKey: string): Promise<ConnectorState> {
  const row = await loadInstallation(connectorKey)
  const present = await loadActiveCredentialFields(connectorKey)
  return {
    status: currentStatus(row),
    health: (row?.health_state as HealthState) ?? "unknown",
    grantedScopes: parseScopes(row?.granted_scopes ?? null),
    presentCredentials: present,
    installedAt: row?.installed_at ?? null,
    lastConnectedAt: row?.last_connected_at ?? null,
    lastHealthAt: row?.last_health_at ?? null,
    lastError: row?.last_error ?? null,
  }
}

/** The full marketplace overview for the current tenant — masked, secret-free. */
export async function getMarketplaceOverview(): Promise<PublicConnector[]> {
  await ensureConnectorSchema()
  const connectors: PublicConnector[] = []
  for (const manifest of CONNECTORS) {
    const state = await buildState(manifest.key)
    connectors.push(toPublicConnector(manifest, state))
  }
  assertNoConnectorSecretExposure(connectors)
  return connectors
}

/** One connector's masked public view, or null when the key is unknown. */
export async function getConnectorView(connectorKey: string): Promise<PublicConnector | null> {
  const manifest = getConnector(connectorKey)
  if (!manifest) return null
  await ensureConnectorSchema()
  const state = await buildState(connectorKey)
  const view = toPublicConnector(manifest, state)
  assertNoConnectorSecretExposure([view])
  return view
}

/** The permission (scope) review for an installed connector. */
export async function getConnectorPermissionReview(connectorKey: string): Promise<ScopeReview[]> {
  if (!isKnownConnector(connectorKey)) throw new Error(`Unknown connector "${connectorKey}"`)
  await ensureConnectorSchema()
  const row = await loadInstallation(connectorKey)
  return reviewConnectorPermissions(connectorKey, parseScopes(row?.granted_scopes ?? null))
}

// ---------------------------------------------------------------------------
// Installation row upsert
// ---------------------------------------------------------------------------

async function upsertInstallation(
  connectorKey: string,
  patch: {
    status?: InstallStatus
    grantedScopes?: string[]
    health?: HealthState
    lastError?: string | null
    installedBy?: number
    markInstalled?: boolean
    markConnected?: boolean
    markHealth?: boolean
    markDisconnected?: boolean
  },
): Promise<void> {
  const tenantId = currentTenantId()
  const cols: string[] = ["tenant_id", "connector_key"]
  const vals: any[] = [tenantId, connectorKey]
  const updates: string[] = []
  const add = (col: string, value: any, update: string) => {
    cols.push(col)
    vals.push(value)
    updates.push(update)
  }
  if (patch.status) add("status", patch.status, "`status` = VALUES(`status`)")
  if (patch.grantedScopes) add("granted_scopes", JSON.stringify(patch.grantedScopes), "`granted_scopes` = VALUES(`granted_scopes`)")
  if (patch.health) add("health_state", patch.health, "`health_state` = VALUES(`health_state`)")
  if (patch.lastError !== undefined) add("last_error", patch.lastError, "`last_error` = VALUES(`last_error`)")
  if (patch.installedBy !== undefined) add("installed_by", patch.installedBy, "`installed_by` = VALUES(`installed_by`)")
  if (patch.markInstalled) updates.push("`installed_at` = CURRENT_TIMESTAMP")
  if (patch.markConnected) updates.push("`last_connected_at` = CURRENT_TIMESTAMP")
  if (patch.markHealth) updates.push("`last_health_at` = CURRENT_TIMESTAMP")
  if (patch.markDisconnected) updates.push("`disconnected_at` = CURRENT_TIMESTAMP")

  const placeholders = cols.map(() => "?").join(", ")
  await query(
    `INSERT INTO \`tenant_connector_installations\` (${cols.map((c) => `\`${c}\``).join(", ")})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates.length ? updates.join(", ") : "`updated_at` = CURRENT_TIMESTAMP"}`,
    vals,
  )
}

// ---------------------------------------------------------------------------
// Credential writes (with rollback tracking)
// ---------------------------------------------------------------------------

/**
 * Persist the supplied credentials as new active rows, retiring any prior
 * active row for the same field. Returns the inserted row ids so the caller can
 * ROLL BACK (hard-delete just these rows) if a later step in the same attempt
 * fails — the install must leave no partial credential behind.
 */
async function writeCredentials(
  connectorKey: string,
  credentials: Record<string, string>,
  keys: string[],
  actor: ConnectorActor,
): Promise<number[]> {
  const inserted: number[] = []
  for (const key of keys) {
    const value = String(credentials[key])
    // Retire any current active value for this field before appending the new one.
    await tenantUpdate(
      "tenant_connector_credentials",
      { is_active: 0, revoked_at: new Date() },
      "connector_key = ? AND field_key = ? AND is_active = 1",
      [connectorKey, key],
    )
    const res = await tenantInsert("tenant_connector_credentials", {
      connector_key: connectorKey,
      field_key: key,
      ciphertext: encryptSecret(value),
      is_active: 1,
      created_by: actor.userId,
    })
    inserted.push(res.insertId)
  }
  return inserted
}

/** Hard-delete specific credential rows written during a failed attempt. */
async function rollbackCredentials(ids: number[]): Promise<void> {
  for (const id of ids) {
    try {
      await query(
        `DELETE FROM \`tenant_connector_credentials\` WHERE \`id\` = ? AND \`tenant_id\` = ?`,
        [id, currentTenantId()],
      )
    } catch (err) {
      console.error("[v0] connector credential rollback failed", err)
    }
  }
}

// ---------------------------------------------------------------------------
// Install / reconnect / disconnect / health
// ---------------------------------------------------------------------------

export type InstallOutcome = {
  status: InstallStatus
  health: HealthState
  grantedScopes: string[]
  deduped: boolean
}

function assertReady(connectorKey: string): void {
  if (!isKnownConnector(connectorKey)) throw new Error(`Unknown connector "${connectorKey}"`)
  if (!isEncryptionConfigured()) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is not configured — cannot store connector credentials at rest")
  }
}

async function probeConnector(
  connectorKey: string,
  credentials: Record<string, string>,
  grantedScopes: string[],
): Promise<{ health: HealthState; detail: string | null }> {
  const manifest = getConnector(connectorKey)!
  const adapter = getAdapter(manifest.adapter)
  if (!adapter) {
    // No reviewed adapter — refuse rather than run anything dynamic.
    return { health: "down", detail: `No reviewed adapter for "${manifest.adapter}"` }
  }
  const probe = await adapter.probe({ credentials, grantedScopes }).catch((err) => ({
    ok: false,
    detail: (err as Error).message,
  }))
  return { health: classifyHealth(probe), detail: probe.ok ? null : probe.detail ?? "probe failed" }
}

/**
 * Install a connector: validate scopes + credentials, store credentials
 * encrypted, run the reviewed adapter's readiness probe, and record the install
 * — all with ROLLBACK. If the probe fails or any step throws, every credential
 * written in THIS attempt is deleted and no install is recorded.
 */
export async function installConnector(input: {
  connectorKey: string
  requestedScopes?: string[] | null
  credentials: Record<string, unknown>
  actor: ConnectorActor
  idempotencyKey?: string | null
}): Promise<InstallOutcome> {
  const { connectorKey, requestedScopes, credentials, actor, idempotencyKey } = input
  assertReady(connectorKey)
  await ensureConnectorSchema()

  if (idempotencyKey) {
    const existing = await lookupIdempotent(idempotencyKey)
    if (existing != null) {
      const state = await buildState(connectorKey)
      return { status: state.status, health: state.health, grantedScopes: state.grantedScopes, deduped: true }
    }
  }

  const current = currentStatus(await loadInstallation(connectorKey))
  const gate = canTransition(current, "install")
  if (!gate.ok) throw new Error(gate.reason)

  const scopeRes = resolveGrantedScopes(connectorKey, requestedScopes)
  if (!scopeRes.ok) throw new Error(scopeRes.error)

  const credRes = validateConnectorCredentials(connectorKey, credentials)
  if (!credRes.ok) throw new Error(credRes.error)

  const cleaned: Record<string, string> = {}
  for (const k of credRes.keys) cleaned[k] = String(credentials[k]).trim()

  let insertedIds: number[] = []
  try {
    insertedIds = await writeCredentials(connectorKey, cleaned, credRes.keys, actor)

    const { health, detail } = await probeConnector(connectorKey, cleaned, scopeRes.granted)
    if (health === "down") {
      throw new Error(detail ?? "Connector readiness probe failed")
    }

    await upsertInstallation(connectorKey, {
      status: "installed",
      grantedScopes: scopeRes.granted,
      health,
      lastError: detail,
      installedBy: actor.userId,
      markInstalled: true,
      markConnected: true,
    })

    if (idempotencyKey) await recordIdempotent(idempotencyKey, "install", connectorKey, "installed")
    await recordAudit({
      connectorKey,
      action: "install",
      actor,
      detail: `installed with scopes [${scopeRes.granted.join(", ")}]`,
      idempotencyKey,
    })

    return { status: "installed", health, grantedScopes: scopeRes.granted, deduped: false }
  } catch (err) {
    // Roll back every credential written during this failed attempt.
    await rollbackCredentials(insertedIds)
    await recordAudit({
      connectorKey,
      action: "install_failed",
      actor,
      detail: (err as Error).message,
      idempotencyKey,
    })
    throw err
  }
}

/**
 * Reconnect (re-authenticate) an already-installed or disconnected connector.
 * New credentials may be supplied (rotated in) or, when the current credentials
 * are still active, reused. Runs the readiness probe and, on success, marks the
 * connector installed again. Credential rotation is rolled back on failure.
 */
export async function reconnectConnector(input: {
  connectorKey: string
  requestedScopes?: string[] | null
  credentials?: Record<string, unknown> | null
  actor: ConnectorActor
  idempotencyKey?: string | null
}): Promise<InstallOutcome> {
  const { connectorKey, requestedScopes, credentials, actor, idempotencyKey } = input
  assertReady(connectorKey)
  await ensureConnectorSchema()

  if (idempotencyKey) {
    const existing = await lookupIdempotent(idempotencyKey)
    if (existing != null) {
      const state = await buildState(connectorKey)
      return { status: state.status, health: state.health, grantedScopes: state.grantedScopes, deduped: true }
    }
  }

  const row = await loadInstallation(connectorKey)
  const current = currentStatus(row)
  const gate = canTransition(current, "reconnect")
  if (!gate.ok) throw new Error(gate.reason)

  // Scopes: keep existing unless a new set is explicitly requested.
  const existingScopes = parseScopes(row?.granted_scopes ?? null)
  let grantedScopes = existingScopes
  if (requestedScopes != null) {
    const scopeRes = resolveGrantedScopes(connectorKey, requestedScopes)
    if (!scopeRes.ok) throw new Error(scopeRes.error)
    grantedScopes = scopeRes.granted
  } else if (existingScopes.length === 0) {
    const scopeRes = resolveGrantedScopes(connectorKey, null)
    if (scopeRes.ok) grantedScopes = scopeRes.granted
  }

  const supplied = credentials ?? null
  const hasSupplied = supplied != null && Object.keys(supplied).length > 0

  let insertedIds: number[] = []
  try {
    let effectiveCreds: Record<string, string>
    if (hasSupplied) {
      const credRes = validateConnectorCredentials(connectorKey, supplied!)
      if (!credRes.ok) throw new Error(credRes.error)
      const cleaned: Record<string, string> = {}
      for (const k of credRes.keys) cleaned[k] = String(supplied![k]).trim()
      insertedIds = await writeCredentials(connectorKey, cleaned, credRes.keys, actor)
      // Merge with any still-active credentials not re-supplied this time.
      effectiveCreds = { ...(await loadActiveCredentials(connectorKey)) }
    } else {
      effectiveCreds = await loadActiveCredentials(connectorKey)
      if (Object.keys(effectiveCreds).length === 0) {
        throw new Error("Re-authentication required: no stored credentials to reconnect with")
      }
    }

    const { health, detail } = await probeConnector(connectorKey, effectiveCreds, grantedScopes)
    if (health === "down") throw new Error(detail ?? "Connector readiness probe failed")

    await upsertInstallation(connectorKey, {
      status: "installed",
      grantedScopes,
      health,
      lastError: detail,
      markConnected: true,
    })

    if (idempotencyKey) await recordIdempotent(idempotencyKey, "reconnect", connectorKey, "installed")
    await recordAudit({ connectorKey, action: "reconnect", actor, detail: "reconnected", idempotencyKey })

    return { status: "installed", health, grantedScopes, deduped: false }
  } catch (err) {
    await rollbackCredentials(insertedIds)
    await recordAudit({ connectorKey, action: "reconnect_failed", actor, detail: (err as Error).message, idempotencyKey })
    throw err
  }
}

/**
 * Disconnect a connector: REVOKE every active credential (they can no longer be
 * resolved), mark the install disconnected, and reset health. The credential
 * and audit history is preserved for forensics; only the ability to USE the
 * credentials is removed.
 */
export async function disconnectConnector(input: {
  connectorKey: string
  actor: ConnectorActor
  idempotencyKey?: string | null
}): Promise<{ status: InstallStatus; revoked: number; deduped: boolean }> {
  const { connectorKey, actor, idempotencyKey } = input
  if (!isKnownConnector(connectorKey)) throw new Error(`Unknown connector "${connectorKey}"`)
  await ensureConnectorSchema()

  if (idempotencyKey) {
    const existing = await lookupIdempotent(idempotencyKey)
    if (existing != null) return { status: "disconnected", revoked: 0, deduped: true }
  }

  const current = currentStatus(await loadInstallation(connectorKey))
  const gate = canTransition(current, "disconnect")
  if (!gate.ok) throw new Error(gate.reason)

  const revoked = await revokeActiveCredentials(connectorKey)
  await upsertInstallation(connectorKey, {
    status: "disconnected",
    health: "unknown",
    lastError: null,
    markDisconnected: true,
  })

  if (idempotencyKey) await recordIdempotent(idempotencyKey, "disconnect", connectorKey, "disconnected")
  await recordAudit({
    connectorKey,
    action: "disconnect",
    actor,
    detail: `disconnected; revoked ${revoked} credential(s)`,
    idempotencyKey,
  })

  return { status: "disconnected", revoked, deduped: false }
}

/**
 * Health check: run the reviewed adapter's readiness probe against the active
 * credentials of an INSTALLED connector, persist and audit the result.
 */
export async function checkConnectorHealth(input: {
  connectorKey: string
  actor: ConnectorActor
}): Promise<{ health: HealthState; detail: string | null }> {
  const { connectorKey, actor } = input
  if (!isKnownConnector(connectorKey)) throw new Error(`Unknown connector "${connectorKey}"`)
  await ensureConnectorSchema()

  const row = await loadInstallation(connectorKey)
  const current = currentStatus(row)
  const gate = canTransition(current, "health")
  if (!gate.ok) throw new Error(gate.reason)

  const credentials = await loadActiveCredentials(connectorKey)
  const grantedScopes = parseScopes(row?.granted_scopes ?? null)
  const { health, detail } = await probeConnector(connectorKey, credentials, grantedScopes)

  await upsertInstallation(connectorKey, { health, lastError: detail, markHealth: true })
  await recordAudit({ connectorKey, action: "health", actor, detail: `health=${health}${detail ? ` (${detail})` : ""}` })

  return { health, detail }
}

/**
 * Resolve a single decrypted credential for server-side connector use (the
 * reviewed adapters and background jobs). SERVER-ONLY, tenant-scoped, audited.
 * Never returns toward a client.
 */
export async function resolveConnectorCredential(
  connectorKey: string,
  fieldKey: string,
  actor?: ConnectorActor | null,
): Promise<string | null> {
  if (!isKnownConnector(connectorKey)) throw new Error(`Unknown connector "${connectorKey}"`)
  await ensureConnectorSchema()
  const { where, params } = scopedWhere(
    "tenant_connector_credentials",
    "connector_key = ? AND field_key = ? AND is_active = 1",
    [connectorKey, fieldKey],
  )
  const rows = await query<any[]>(
    `SELECT ciphertext FROM \`tenant_connector_credentials\` ${where} ORDER BY \`id\` DESC LIMIT 1`,
    params,
  )
  if (!rows.length) return null
  const plain = decryptSecret(rows[0].ciphertext)
  await recordAudit({ connectorKey, action: "access", actor: actor ?? null, detail: `resolved ${fieldKey}` })
  return plain
}
