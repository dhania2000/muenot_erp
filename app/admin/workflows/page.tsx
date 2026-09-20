import { requireTenantAdmin } from "@/lib/platform-guard"
import { WorkflowConsole } from "@/components/workflow-console"
export const dynamic = "force-dynamic"
export default async function Page({searchParams}: {searchParams: Promise<{recordId?:string}>}) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p>Tenant administrator access is required.</p>
  const {recordId} = await searchParams
  return <WorkflowConsole initialRecordId={recordId && /^\d+$/.test(recordId) ? recordId : ""} />
}
