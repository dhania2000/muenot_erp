import { billingGuard } from "@/lib/billing-guard"
import { ReconciliationConsole } from "@/components/billing/reconciliation-console"

export default async function Page() {
  await billingGuard()
  return <ReconciliationConsole />
}
