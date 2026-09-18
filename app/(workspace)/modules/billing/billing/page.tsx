import { billingGuard } from "@/lib/billing-guard"
import { BillingRunConsole } from "@/components/billing/billing-run-console"

export default async function Page() {
  await billingGuard()
  return <BillingRunConsole />
}
