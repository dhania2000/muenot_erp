import "server-only"
/**
 * SPEC 56-58 — SSO identity provider store (OIDC + SAML).
 * ---------------------------------------------------------------------------
 * Owns CRUD for tenant identity providers and the client-secret encryption
 * boundary. Secrets are stored ONLY as the AES-256-GCM envelope from
 * lib/secrets/crypto.ts (the same master key already used by the managed
 * secrets store) — a plaintext client secret never reaches a column, and
 * `toPublicProvider` never serializes it back to a client.
 *
 * The actual protocol handshakes (authorization-code exchange, ID-token/JWKS
 * verification for OIDC; AuthnRequest + signed-assertion verification for
 * SAML) live in lib/sso-oidc.ts / lib/sso-saml.ts, invoked from
 * app/api/auth/sso/[providerId]/*. This module is the persistence layer both
 * share.
 */
import { query } from "@/lib/db"
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto"

export type SsoProviderType = "oidc" | "saml"
export type SsoProviderStatus = "draft" | "enabled" | "disabled"

export type SsoProviderRow = {
  id: number
  tenant_id: number | null
  type: SsoProviderType
  name: string
  status: SsoProviderStatus
  domains: string | null
  auto_provision: number
  default_role: "admin" | "employee"
  issuer_url: string | null
  discovery_url: string | null
  authorization_endpoint: string | null
  token_endpoint: string | null
  userinfo_endpoint: string | null
  jwks_uri: string | null
  client_id: string | null
  client_secret_encrypted: string | null
  scopes: string | null
  entity_id: string | null
  sso_url: string | null
  certificate: string | null
  email_attribute: string | null
  first_name_attribute: string | null
  last_name_attribute: string | null
  employee_id_attribute: string | null
  created_by: number | null
  created_at: string
  updated_at: string
  last_login_at: string | null
  last_test_at: string | null
  last_test_ok: number | null
  last_test_message: string | null
}

/** The safe, client-facing projection — never includes the encrypted secret, only whether one is set. */
export type PublicSsoProvider = Omit<SsoProviderRow, "client_secret_encrypted" | "tenant_id" | "auto_provision"> & {
  hasClientSecret: boolean
  autoProvision: boolean
  tenantId: number | null
}
export type SsoIdentityRow = {
  id: number; provider_id: number; tenant_id: number | null; user_id: number; subject: string
  email_at_link: string | null; deprovisioned_at: string | null; created_at: string; updated_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`sso_providers\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`type\` ENUM('oidc','saml') NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`status\` ENUM('draft','enabled','disabled') NOT NULL DEFAULT 'draft',
      \`domains\` VARCHAR(255) DEFAULT NULL,
      \`auto_provision\` TINYINT(1) NOT NULL DEFAULT 1,
      \`default_role\` ENUM('admin','employee') NOT NULL DEFAULT 'employee',
      \`issuer_url\` VARCHAR(255) DEFAULT NULL,
      \`discovery_url\` VARCHAR(255) DEFAULT NULL,
      \`authorization_endpoint\` VARCHAR(255) DEFAULT NULL,
      \`token_endpoint\` VARCHAR(255) DEFAULT NULL,
      \`userinfo_endpoint\` VARCHAR(255) DEFAULT NULL,
      \`jwks_uri\` VARCHAR(255) DEFAULT NULL,
      \`client_id\` VARCHAR(255) DEFAULT NULL,
      \`client_secret_encrypted\` TEXT DEFAULT NULL,
      \`scopes\` VARCHAR(255) DEFAULT 'openid email profile',
      \`entity_id\` VARCHAR(255) DEFAULT NULL,
      \`sso_url\` VARCHAR(255) DEFAULT NULL,
      \`certificate\` TEXT DEFAULT NULL,
      \`email_attribute\` VARCHAR(120) DEFAULT NULL,
      \`first_name_attribute\` VARCHAR(120) DEFAULT NULL,
      \`last_name_attribute\` VARCHAR(120) DEFAULT NULL,
      \`employee_id_attribute\` VARCHAR(120) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`last_login_at\` DATETIME DEFAULT NULL,
      \`last_test_at\` DATETIME DEFAULT NULL,
      \`last_test_ok\` TINYINT(1) DEFAULT NULL,
      \`last_test_message\` VARCHAR(255) DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_sso_providers_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`sso_login_events\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`provider_id\` INT UNSIGNED NOT NULL,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`user_id\` INT UNSIGNED DEFAULT NULL,
      \`email\` VARCHAR(190) DEFAULT NULL,
      \`status\` VARCHAR(20) NOT NULL,
      \`message\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_sso_login_events_provider\` (\`provider_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`CREATE TABLE IF NOT EXISTS \`sso_identities\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT, \`provider_id\` INT UNSIGNED NOT NULL,
    \`tenant_id\` INT UNSIGNED DEFAULT NULL, \`user_id\` INT UNSIGNED NOT NULL, \`subject\` VARCHAR(255) NOT NULL,
    \`email_at_link\` VARCHAR(190) DEFAULT NULL, \`deprovisioned_at\` DATETIME DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uniq_sso_identity_subject\` (\`provider_id\`, \`subject\`),
    UNIQUE KEY \`uniq_sso_identity_user\` (\`provider_id\`, \`user_id\`), KEY \`idx_sso_identity_tenant\` (\`tenant_id\`, \`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`sso_saml_requests\` (\`request_id\` VARCHAR(255) NOT NULL, \`provider_id\` INT UNSIGNED NOT NULL, \`request_xml\` MEDIUMTEXT NOT NULL, \`expires_at\` DATETIME NOT NULL, PRIMARY KEY(\`request_id\`), KEY \`idx_sso_saml_request_expiry\` (\`expires_at\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export async function ensureSsoSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

export function toPublicProvider(row: SsoProviderRow): PublicSsoProvider {
  const { client_secret_encrypted, tenant_id, auto_provision, ...rest } = row
  return {
    ...rest,
    hasClientSecret: Boolean(client_secret_encrypted),
    autoProvision: Boolean(auto_provision),
    tenantId: tenant_id,
  }
}

export async function listProviders(tenantId: number | null): Promise<PublicSsoProvider[]> {
  await ensureSsoSchema()
  const rows = await query<SsoProviderRow[]>(
    `SELECT * FROM \`sso_providers\` ${tenantId != null ? "WHERE `tenant_id` = ?" : ""} ORDER BY \`created_at\` DESC`,
    tenantId != null ? [tenantId] : [],
  )
  return rows.map(toPublicProvider)
}

/** Enabled providers visible on the public login page (no admin auth required — used to render "Continue with ..."). */
export async function listEnabledProvidersForLogin(): Promise<{ id: number; name: string; type: SsoProviderType }[]> {
  await ensureSsoSchema()
  const rows = await query<{ id: number; name: string; type: SsoProviderType }[]>(
    `SELECT \`id\`, \`name\`, \`type\` FROM \`sso_providers\` WHERE \`status\` = 'enabled' ORDER BY \`name\` ASC`,
  )
  return rows
}

export async function getProviderById(id: number): Promise<SsoProviderRow | null> {
  await ensureSsoSchema()
  const rows = await query<SsoProviderRow[]>(`SELECT * FROM \`sso_providers\` WHERE \`id\` = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/** Resolve the effective client secret for a provider (server-only; never return this to a client). */
export function resolveClientSecret(row: SsoProviderRow): string | null {
  return decryptSecret(row.client_secret_encrypted)
}

export type ProviderInput = {
  type: SsoProviderType
  name: string
  domains?: string | null
  autoProvision?: boolean
  defaultRole?: "admin" | "employee"
  issuerUrl?: string | null
  discoveryUrl?: string | null
  authorizationEndpoint?: string | null
  tokenEndpoint?: string | null
  userinfoEndpoint?: string | null
  jwksUri?: string | null
  clientId?: string | null
  clientSecret?: string | null // plaintext in, encrypted before storage
  scopes?: string | null
  entityId?: string | null
  ssoUrl?: string | null
  certificate?: string | null
  emailAttribute?: string | null
  firstNameAttribute?: string | null
  lastNameAttribute?: string | null
  employeeIdAttribute?: string | null
}

export async function createProvider(
  tenantId: number | null,
  input: ProviderInput,
  createdBy: number,
): Promise<number> {
  await ensureSsoSchema()
  const secretEnvelope = input.clientSecret ? encryptSecret(input.clientSecret) : null
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`sso_providers\`
       (\`tenant_id\`, \`type\`, \`name\`, \`status\`, \`domains\`, \`auto_provision\`, \`default_role\`,
        \`issuer_url\`, \`discovery_url\`, \`authorization_endpoint\`, \`token_endpoint\`, \`userinfo_endpoint\`,
        \`jwks_uri\`, \`client_id\`, \`client_secret_encrypted\`, \`scopes\`,
        \`entity_id\`, \`sso_url\`, \`certificate\`, \`email_attribute\`, \`first_name_attribute\`,
        \`last_name_attribute\`, \`employee_id_attribute\`, \`created_by\`)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.type,
      input.name,
      input.domains ?? null,
      input.autoProvision === false ? 0 : 1,
      input.defaultRole ?? "employee",
      input.issuerUrl ?? null,
      input.discoveryUrl ?? null,
      input.authorizationEndpoint ?? null,
      input.tokenEndpoint ?? null,
      input.userinfoEndpoint ?? null,
      input.jwksUri ?? null,
      input.clientId ?? null,
      secretEnvelope,
      input.scopes || "openid email profile",
      input.entityId ?? null,
      input.ssoUrl ?? null,
      input.certificate ?? null,
      input.emailAttribute || "email",
      input.firstNameAttribute ?? null,
      input.lastNameAttribute ?? null,
      input.employeeIdAttribute ?? null,
      createdBy,
    ],
  )
  return (result as any).insertId
}

export async function updateProvider(id: number, input: Partial<ProviderInput>): Promise<void> {
  await ensureSsoSchema()
  const sets: string[] = []
  const params: unknown[] = []

  const map: Record<string, unknown> = {
    name: input.name,
    domains: input.domains,
    auto_provision: input.autoProvision === undefined ? undefined : input.autoProvision ? 1 : 0,
    default_role: input.defaultRole,
    issuer_url: input.issuerUrl,
    discovery_url: input.discoveryUrl,
    authorization_endpoint: input.authorizationEndpoint,
    token_endpoint: input.tokenEndpoint,
    userinfo_endpoint: input.userinfoEndpoint,
    jwks_uri: input.jwksUri,
    client_id: input.clientId,
    scopes: input.scopes,
    entity_id: input.entityId,
    sso_url: input.ssoUrl,
    certificate: input.certificate,
    email_attribute: input.emailAttribute,
    first_name_attribute: input.firstNameAttribute,
    last_name_attribute: input.lastNameAttribute,
    employee_id_attribute: input.employeeIdAttribute,
  }
  for (const [col, val] of Object.entries(map)) {
    if (val === undefined) continue
    sets.push(`\`${col}\` = ?`)
    params.push(val)
  }
  if (input.clientSecret) {
    sets.push(`\`client_secret_encrypted\` = ?`)
    params.push(encryptSecret(input.clientSecret))
  }
  if (sets.length === 0) return
  params.push(id)
  await query(`UPDATE \`sso_providers\` SET ${sets.join(", ")} WHERE \`id\` = ?`, params)
}

export async function setProviderStatus(id: number, status: SsoProviderStatus): Promise<void> {
  await ensureSsoSchema()
  await query(`UPDATE \`sso_providers\` SET \`status\` = ? WHERE \`id\` = ?`, [status, id])
}

export async function deleteProvider(id: number): Promise<void> {
  await ensureSsoSchema()
  await query(`DELETE FROM \`sso_providers\` WHERE \`id\` = ?`, [id])
}

export async function recordTestResult(id: number, ok: boolean, message: string): Promise<void> {
  await ensureSsoSchema()
  await query(
    `UPDATE \`sso_providers\` SET \`last_test_at\` = CURRENT_TIMESTAMP, \`last_test_ok\` = ?, \`last_test_message\` = ?
     WHERE \`id\` = ?`,
    [ok ? 1 : 0, message.slice(0, 255), id],
  )
}

export async function recordLogin(id: number): Promise<void> {
  await ensureSsoSchema()
  await query(`UPDATE \`sso_providers\` SET \`last_login_at\` = CURRENT_TIMESTAMP WHERE \`id\` = ?`, [id])
}

export async function recordLoginEvent(input: {
  providerId: number
  tenantId?: number | null
  userId?: number | null
  email?: string | null
  status: "success" | "error"
  message?: string | null
}): Promise<void> {
  try {
    await ensureSsoSchema()
    await query(
      `INSERT INTO \`sso_login_events\` (\`provider_id\`, \`tenant_id\`, \`user_id\`, \`email\`, \`status\`, \`message\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.providerId,
        input.tenantId ?? null,
        input.userId ?? null,
        input.email ?? null,
        input.status,
        input.message ? input.message.slice(0, 255) : null,
      ],
    )
  } catch (err) {
    console.error("[v0] sso login event write failed", err)
  }
}

export async function getIdentity(providerId: number, subject: string): Promise<SsoIdentityRow | null> {
  await ensureSsoSchema()
  const rows = await query<SsoIdentityRow[]>("SELECT * FROM `sso_identities` WHERE `provider_id`=? AND `subject`=? LIMIT 1", [providerId, subject])
  return rows[0] ?? null
}

/** Link only after the caller has tenant-scoped the user and verified the IdP subject. */
export async function linkIdentity(input: { providerId: number; tenantId: number | null; userId: number; subject: string; email: string }) {
  await ensureSsoSchema()
  await query(`INSERT INTO \`sso_identities\` (\`provider_id\`,\`tenant_id\`,\`user_id\`,\`subject\`,\`email_at_link\`)
    VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE \`user_id\`=VALUES(\`user_id\`),\`tenant_id\`=VALUES(\`tenant_id\`),\`email_at_link\`=VALUES(\`email_at_link\`),\`deprovisioned_at\`=NULL`, [input.providerId,input.tenantId,input.userId,input.subject,input.email])
}

/** Deprovision a tenant identity and immediately revoke all local sessions. */
export async function deprovisionIdentity(input: { providerId: number; identityId: number; tenantId: number | null }) {
  await ensureSsoSchema()
  const rows = await query<SsoIdentityRow[]>("SELECT * FROM `sso_identities` WHERE `id`=? AND `provider_id`=? AND `tenant_id` <=> ? LIMIT 1", [input.identityId,input.providerId,input.tenantId])
  const identity = rows[0]
  if (!identity) throw new Error("SSO identity not found")
  await query("UPDATE `sso_identities` SET `deprovisioned_at`=CURRENT_TIMESTAMP WHERE `id`=?", [identity.id])
  await query("UPDATE `users` SET `status`='inactive' WHERE `id`=? AND `tenant_id` <=> ?", [identity.user_id,input.tenantId])
  const { revokeAllSessionsForUser } = await import("@/lib/session-store")
  await revokeAllSessionsForUser(identity.user_id, { reason: "sso_deprovisioned" })
  return identity
}
