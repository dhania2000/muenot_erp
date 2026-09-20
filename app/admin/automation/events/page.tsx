import { requireTenantAdmin } from "@/lib/platform-guard"
import { EventMonitor } from "@/components/automation/event-monitor"
import { BusinessEventMonitor } from "@/components/automation/business-event-monitor"

export const dynamic = "force-dynamic"

export default async function Page() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  return <><BusinessEventMonitor/><details className="m-6 border rounded p-3"><summary>Existing workflow run monitor (separate from business events)</summary><EventMonitor/></details></>
}
