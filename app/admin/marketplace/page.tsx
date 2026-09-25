import { Blocks } from "lucide-react"
import { isEncryptionConfigured } from "@/lib/secrets/crypto"
import { ConnectorMarketplace } from "@/components/admin/connector-marketplace"

/**
 * Integration marketplace console (Spec 15, #88-89). A tenant admin browses the
 * installable connector catalog (Tally, Zoho, Microsoft, Google, Slack) and
 * installs, reconnects, disconnects, health-checks and reviews the permissions
 * of each connector. Credentials are encrypted at rest, masked here, and never
 * shared across tenants. All connector behaviour runs through reviewed
 * server-side adapters — tenant input never becomes executable code.
 */
export const dynamic = "force-dynamic"

export default function MarketplacePage() {
  const encryptionConfigured = isEncryptionConfigured()

  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Blocks className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Integration marketplace</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Install curated connectors to sync your workspace with Tally, Zoho, Microsoft, Google and Slack. Each
          connector declares the scopes, credentials and events it uses up front. Install, reconnect, disconnect,
          health-check and review permissions — all scoped to your workspace and backed by reviewed server adapters.
        </p>
      </header>

      <ConnectorMarketplace encryptionConfigured={encryptionConfigured} />
    </div>
  )
}
