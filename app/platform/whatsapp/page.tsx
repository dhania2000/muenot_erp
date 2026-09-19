import { requirePlatformStaff } from "@/lib/platform-guard"
import { listWhatsAppTenantConnections } from "@/lib/whatsapp"
import { PlatformWhatsAppTenants } from "@/components/platform/platform-whatsapp-tenants"

export const dynamic = "force-dynamic"

export default async function PlatformWhatsAppPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const tenants = await listWhatsAppTenantConnections()
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp by tenant</h1>
        <p className="text-sm text-muted-foreground">
          Connect each customer to its own WhatsApp Business Account. Every WABA, phone number and encrypted token is
          stored against that tenant only.
        </p>
      </header>
      <PlatformWhatsAppTenants tenants={tenants} />
    </div>
  )
}
