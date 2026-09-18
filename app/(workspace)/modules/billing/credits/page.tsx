import { billingGuard } from "@/lib/billing-guard"
import { CreditConsole } from "@/components/billing/credit-console"

export default async function Page() {
  await billingGuard()
  return <CreditConsole />
}
