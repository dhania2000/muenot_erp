import { billingGuard } from "@/lib/billing-guard"
import { RenewalsClient } from "@/components/billing/renewals-client"

export default async function Page() {
  await billingGuard()
  return <RenewalsClient />
}
