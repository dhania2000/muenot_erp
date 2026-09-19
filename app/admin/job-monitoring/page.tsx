import { requireTenantAdmin } from "@/lib/platform-guard"
import { JobMonitor } from "@/components/job-monitor"
export const dynamic = "force-dynamic"
export default async function Page() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p>Tenant administrator access is required.</p>
  return <JobMonitor audience="tenant" />
}
