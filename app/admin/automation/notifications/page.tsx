import { requireTenantAdmin } from "@/lib/platform-guard"
import { NotificationCenter } from "@/components/automation/notification-center"
import { NotificationEnginePanel } from "@/components/automation/notification-engine-panel"

export const dynamic = "force-dynamic"

export default async function Page() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  return <><NotificationEnginePanel/><details className="m-6 border rounded p-3"><summary>Existing in-app notification history</summary><NotificationCenter/></details></>
}
