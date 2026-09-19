import { billingGuard } from "@/lib/billing-guard"
import { EntitlementsView } from "@/components/billing/entitlements-view"

export default async function Page() {
  await billingGuard()
  return <EntitlementsView />
}
