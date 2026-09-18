import { billingGuard } from "@/lib/billing-guard"
import { SubscriptionConsole } from "@/components/billing/subscription-console"

export default async function Page() {
  await billingGuard()
  return <SubscriptionConsole />
}
