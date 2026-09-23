import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { SystemMonitoringConsole } from "@/components/platform/system-monitoring-console"

export const dynamic = "force-dynamic"
export default async function Page() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return <p>Super Admin access is required.</p>
  return <SystemMonitoringConsole />
}
