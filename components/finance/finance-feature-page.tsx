"use client"

import { FinanceDashboardClient } from "@/components/finance/finance-dashboard-client"

export function FinanceFeaturePage({ module }: { module: string }) {
  return <FinanceDashboardClient initialModule={module} />
}
