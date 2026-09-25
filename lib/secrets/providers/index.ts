import "server-only"
import { AwsSecretsManagerProvider } from "./aws-secrets-manager"
import { AzureKeyVaultProvider } from "./azure-key-vault"
import { DatabaseVaultProvider } from "./db-vault"
import { type VaultKind, type VaultProvider, isVaultKind } from "./types"

/**
 * Vault provider factory — wires deployment configuration (env) into concrete
 * adapters. This is the ONLY place that reads provider credentials from the
 * environment, so the adapters and the pure core stay testable in isolation.
 *
 * The encrypted DB vault is ALWAYS constructible (no config needed) and is the
 * fallback. An external vault is only constructible when its full credential
 * set is present; otherwise the factory returns null and callers collapse to
 * `db`, so a half-configured external vault can never strand a secret.
 */

export * from "./types"
export { DatabaseVaultProvider } from "./db-vault"
export { AwsSecretsManagerProvider } from "./aws-secrets-manager"
export { AzureKeyVaultProvider } from "./azure-key-vault"

const dbVault = new DatabaseVaultProvider()

/** The always-available encrypted database vault. */
export function getDatabaseVault(): DatabaseVaultProvider {
  return dbVault
}

/** The deployment-configured default external vault kind, if any. */
export function configuredDefaultVaultKind(env: NodeJS.ProcessEnv = process.env): VaultKind | null {
  const raw = (env.SECRETS_VAULT_PROVIDER ?? "").trim().toLowerCase()
  return isVaultKind(raw) && raw !== "db" ? raw : null
}

function buildAws(env: NodeJS.ProcessEnv): AwsSecretsManagerProvider | null {
  const region = (env.SECRETS_AWS_REGION ?? env.AWS_REGION ?? "").trim()
  const accessKeyId = (env.SECRETS_AWS_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? "").trim()
  const secretAccessKey = (env.SECRETS_AWS_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? "").trim()
  if (!region || !accessKeyId || !secretAccessKey) return null
  const sessionToken = (env.SECRETS_AWS_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN ?? "").trim() || null
  const prefix = (env.SECRETS_AWS_PREFIX ?? "").trim() || undefined
  const timeoutMs = Number(env.SECRETS_VAULT_TIMEOUT_MS)
  return new AwsSecretsManagerProvider({
    region,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    prefix,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  })
}

function buildAzure(env: NodeJS.ProcessEnv): AzureKeyVaultProvider | null {
  const vaultName = (env.SECRETS_AZURE_VAULT_NAME ?? "").trim()
  const tenantId = (env.SECRETS_AZURE_TENANT_ID ?? "").trim()
  const clientId = (env.SECRETS_AZURE_CLIENT_ID ?? "").trim()
  const clientSecret = (env.SECRETS_AZURE_CLIENT_SECRET ?? "").trim()
  if (!vaultName || !tenantId || !clientId || !clientSecret) return null
  const timeoutMs = Number(env.SECRETS_VAULT_TIMEOUT_MS)
  return new AzureKeyVaultProvider({
    vaultName,
    tenantId,
    clientId,
    clientSecret,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  })
}

/**
 * Build the provider for a given kind, or null when it is an external vault
 * that is not fully configured. `db` always succeeds.
 */
export function buildVaultProvider(
  kind: VaultKind,
  env: NodeJS.ProcessEnv = process.env,
): VaultProvider | null {
  switch (kind) {
    case "db":
      return dbVault
    case "aws_secrets_manager":
      return buildAws(env)
    case "azure_key_vault":
      return buildAzure(env)
    default:
      return null
  }
}

/** True when the given external vault kind is fully configured in this deployment. */
export function isVaultConfigured(kind: VaultKind, env: NodeJS.ProcessEnv = process.env): boolean {
  if (kind === "db") return true
  return buildVaultProvider(kind, env) !== null
}
