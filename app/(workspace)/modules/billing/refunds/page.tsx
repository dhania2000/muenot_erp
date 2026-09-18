import { billingGuard } from "@/lib/billing-guard"
import { RefundConsole } from "@/components/billing/refund-console"

export default async function Page() {
  await billingGuard()
  return <RefundConsole />
}
