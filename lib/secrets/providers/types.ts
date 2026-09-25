/**
 * External secrets vault — provider abstraction (PURE CORE).
 * ---------------------------------------------------------------------------
 * Spec 9 adds real external vaults (AWS Secrets Manager, Azure Key Vault)
 * BEHIND the existing secret abstraction, while the encrypted database vault
 * (lib/secrets/crypto.ts + the managed_secret_versions table) stays as the
 * always-available fallback. Everything a consumer needs to reason about a
 * provider WITHOUT touching the network or a database lives here so it is
 * unit-testable directly:
 *
 *   • the provider kinds and the `VaultProvider` contract every adapter meets;
 *   • the health-state model + classification (`classifyHealth`) that turns a
 *     connection probe into a stable `HealthState`;
 *   • provider SELECTION (`selectVaultKind`) — which vault a given integration
 *     secret resolves through, honouring an explicit choice, then env config,
 *     then the DB fallback — so a misconfigured or unreachable external vault
 *     never silently drops a tenant to plaintext or the wrong store.
 *
 * NO `server-only`, NO `process.env` reads, NO DB — pure functions on plain
 * inputs. Adapters (aws-secrets-manager.ts, azure-key-vault.ts, db-vault.ts)
 * implement the contract; the factory (index.ts) wires env + crypto in.
 */

/** The vaults a secret value can live in. `db` is the encrypted local fallback. */
export const VAULT_KINDS = ["db", "aws_secrets_manager", "azure_key_vault"] as const
export type VaultKind = (typeof VAULT_KINDS)[number]

export const VAULT_KIND_LABELS: Record<VaultKind, string> = {
  db: "Encrypted database vault",
  aws_secrets_manager: "AWS Secrets Manager",
  azure_key_vault: "Azure Key Vault",
}

export function isVaultKind(value: unknown): value is VaultKind {
  return typeof value === "string" && (VAULT_KINDS as readonly string[]).includes(value)
}

/** Health of a provider connection, worst-to-best is: down < degraded < unknown < healthy. */
export const HEALTH_STATES = ["healthy", "degraded", "down", "unknown"] as const
export type HealthState = (typeof HEALTH_STATES)[number]

/** The result of writing a value to a vault: the opaque version handle it minted. */
export type VaultWriteResult = {
  /** Provider-native version identifier (AWS VersionId, Azure version segment, or our numeric string). */
  providerVersion: string
}

/** The result of reading a value back from a vault. */
export type VaultReadResult = {
  value: string
  providerVersion: string | null
}

/** A single connection probe outcome, before it is classified into a HealthState. */
export type ProbeResult = {
  ok: boolean
  /** Round-trip latency in ms when measured. */
  latencyMs?: number
  /** True when the failure was a timeout (as opposed to auth/refused/etc). */
  timedOut?: boolean
  detail?: string | null
}

/**
 * The contract every vault adapter meets. A `ref` is the provider-side NAME of
 * the secret (e.g. an AWS secret name or an Azure secret id) — never a tenant
 * plaintext. Adapters MUST fail closed: any transport/auth error rejects (the
 * store converts that into the DB fallback + a degraded/down health), and a
 * successful clean read returns the value. No adapter ever logs a plaintext.
 */
export interface VaultProvider {
  readonly kind: VaultKind
  /** Write (create or new version) a secret value; resolves the new provider version. */
  putSecret(ref: string, value: string): Promise<VaultWriteResult>
  /** Read the current (or a specific) secret value. Rejects when absent/unreachable. */
  getSecret(ref: string, providerVersion?: string | null): Promise<VaultReadResult>
  /** Probe reachability + auth WITHOUT moving any secret material. */
  probe(): Promise<ProbeResult>
}

/**
 * Classify a probe into a stable health state. A clean probe is `healthy`; a
 * timeout is `degraded` (reachable-ish but slow/flaky — worth a retry); any
 * other failure is `down`. A probe that was never run is `unknown`.
 */
export function classifyHealth(probe: ProbeResult | null | undefined): HealthState {
  if (!probe) return "unknown"
  if (probe.ok) return "healthy"
  if (probe.timedOut) return "degraded"
  return "down"
}

/** True when a health state should still allow serving from the external vault. */
export function isServable(state: HealthState): boolean {
  return state === "healthy" || state === "degraded"
}

export type VaultSelectionInput = {
  /** Explicit per-secret choice persisted with the integration (wins when set). */
  explicit?: VaultKind | null
  /** Deployment-configured default external vault (from env), when any. */
  configuredDefault?: VaultKind | null
  /** Whether the externally-configured vault is actually usable right now. */
  externalUsable?: boolean
}

/**
 * Decide which vault a secret resolves through. Precedence:
 *   1. an explicit, usable external choice;
 *   2. the configured default external vault, when usable;
 *   3. the encrypted DB vault (always available) as the fallback.
 * An external choice that is NOT usable (unconfigured/unreachable) collapses to
 * `db` so a value is never written somewhere it cannot later be read.
 */
export function selectVaultKind(input: VaultSelectionInput): VaultKind {
  const { explicit, configuredDefault, externalUsable = true } = input
  if (explicit && explicit !== "db") {
    return externalUsable ? explicit : "db"
  }
  if (explicit === "db") return "db"
  if (configuredDefault && configuredDefault !== "db" && externalUsable) {
    return configuredDefault
  }
  return "db"
}
