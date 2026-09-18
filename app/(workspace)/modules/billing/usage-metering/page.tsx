import { billingGuard } from "@/lib/billing-guard"
import { UsageMeteringConsole } from "@/components/billing/usage-metering-console"

export default async function Page() {
  await billingGuard()
  return <UsageMeteringConsole />
}
