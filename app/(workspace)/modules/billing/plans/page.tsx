import { billingGuard } from "@/lib/billing-guard"
import { PlanCatalog } from "@/components/billing/plan-catalog"

export default async function Page() {
  await billingGuard()
  return <PlanCatalog />
}
