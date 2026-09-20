import { requireTenantAdmin } from "@/lib/platform-guard"
import { AutomationOverview } from "@/components/automation/automation-overview"

export const dynamic = "force-dynamic"

export default async function Page() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  return <AutomationOverview />
}
