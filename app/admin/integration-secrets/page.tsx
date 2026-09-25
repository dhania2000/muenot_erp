import { KeyRound } from "lucide-react"
import { isEncryptionConfigured } from "@/lib/secrets/crypto"
import { configuredDefaultVaultKind, isVaultConfigured } from "@/lib/secrets/providers"
import { IntegrationSecretsManager } from "@/components/admin/integration-secrets-manager"

/**
 * Tenant integration secrets console. A tenant admin manages their own
 * integration credentials (Stripe/SMTP/Twilio/…), stored in an external vault
 * (AWS Secrets Manager / Azure Key Vault) or the encrypted DB fallback. No
 * plaintext ever reaches this surface — only the masked, exposure-free view.
 */
export const dynamic = "force-dynamic"

export default function IntegrationSecretsPage() {
  const encryptionConfigured = isEncryptionConfigured()
  const availableVaults = {
    aws: isVaultConfigured("aws_secrets_manager"),
    azure: isVaultConfigured("azure_key_vault"),
    defaultKind: configuredDefaultVaultKind(),
  }

  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <KeyRound className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Integration secrets</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Store your own integration credentials — payment keys, SMTP passwords, webhook secrets. Values are encrypted
          at rest (or held in your external vault), masked here, versioned for rotation and rollback, and access-audited.
          They are scoped to your workspace and never shared across tenants.
        </p>
      </header>

      <IntegrationSecretsManager encryptionConfigured={encryptionConfigured} availableVaults={availableVaults} />
    </div>
  )
}
