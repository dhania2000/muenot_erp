import "server-only"
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto"
import type { ProbeResult, VaultProvider, VaultReadResult, VaultWriteResult } from "./types"

/**
 * Encrypted database vault adapter (the always-available fallback).
 * ---------------------------------------------------------------------------
 * Wraps the existing AES-256-GCM envelope (lib/secrets/crypto.ts) as a
 * `VaultProvider` so the store can treat the local encrypted store and the
 * external vaults through ONE interface. Unlike the external adapters this one
 * does not persist by itself — it only encrypts/decrypts. The store owns the
 * `tenant_integration_secret_versions` rows; the "ref" here is the ciphertext
 * envelope that the store round-trips. This keeps the DB fallback usable even
 * when every external vault is unreachable, and never exposes plaintext.
 *
 * probe() is always healthy as long as an encryption key is configured, because
 * the local vault has no network dependency.
 */
export class DatabaseVaultProvider implements VaultProvider {
  readonly kind = "db" as const

  /** "Writing" to the DB vault means producing the ciphertext the store persists. */
  async putSecret(_ref: string, value: string): Promise<VaultWriteResult> {
    const envelope = encryptSecret(value)
    return { providerVersion: envelope }
  }

  /**
   * The DB vault reads back from the ciphertext the store stored as the
   * provider version. `ref` is unused; the envelope carries everything.
   */
  async getSecret(_ref: string, providerVersion?: string | null): Promise<VaultReadResult> {
    if (!providerVersion) throw new Error("DB vault read requires the stored ciphertext")
    const value = decryptSecret(providerVersion)
    return { value, providerVersion }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const round = decryptSecret(encryptSecret("healthcheck"))
      return { ok: round === "healthcheck", detail: round === "healthcheck" ? null : "round-trip mismatch" }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }
}
