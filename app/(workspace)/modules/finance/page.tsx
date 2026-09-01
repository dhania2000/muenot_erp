import { FinanceDashboardClient } from "@/components/finance/finance-dashboard-client"

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ module?: string }> }) {
  const params = await searchParams
  return <FinanceDashboardClient initialModule={params.module || "sales-invoices"} />
}
