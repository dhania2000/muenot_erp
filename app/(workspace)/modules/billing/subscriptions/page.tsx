import { billingGuard } from "@/lib/billing-guard"
import { BillingModuleView } from "@/components/billing/billing-module-view"
import { BILLING_CONFIGS } from "@/lib/billing-configs"

export default async function Page() {
  await billingGuard()
  return <BillingModuleView config={BILLING_CONFIGS.subscriptions} />
}
