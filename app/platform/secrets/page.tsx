import { requirePlatformStaff } from "@/lib/platform-guard"
import { getSecretsOverview } from "@/lib/secrets/store"
import { isEncryptionConfigured } from "@/lib/secrets/crypto"
import { SecretsManager } from "@/components/platform/secrets-manager"

/**
 * Secret management console. Any platform staff may VIEW the masked
 * inventory and access audit; only a platform super-admin may set or rotate a
 * value. No plaintext ever reaches this surface — the overview is the masked,
 * exposure-free projection.
 */
export const dynamic = "force-dynamic"

export default async function SecretsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const secrets = await getSecretsOverview()
  const canEdit = guard.ctx.platformRole === "platform_super_admin"
  const encryptionConfigured = isEncryptionConfigured()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="text-sm text-muted-foreground">
          Encrypted at rest, masked in the UI, and access-audited.{" "}
          {canEdit
            ? "Set or rotate a value inline — the plaintext is never shown again."
            : "Setting and rotating values requires platform super-admin authority."}
        </p>
      </header>

      <SecretsManager secrets={secrets} canEdit={canEdit} encryptionConfigured={encryptionConfigured} />
    </div>
  )
}
