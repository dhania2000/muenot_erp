import { OperationsDashboardClient } from "@/components/operations/operations-dashboard-client"

export function OperationsFeaturePage({ module }: { module: string }) {
  return <OperationsDashboardClient initialModule={module} />
}
