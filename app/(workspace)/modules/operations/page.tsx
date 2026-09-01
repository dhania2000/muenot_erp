import { OperationsDashboardClient } from "@/components/operations/operations-dashboard-client"

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ module?: string }> }) {
  const params = await searchParams
  return <OperationsDashboardClient initialModule={params.module || "resources"} />
}
