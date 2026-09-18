import { billingGuard } from "@/lib/billing-guard"
import { CustomerPortalConsole } from "@/components/billing/customer-portal-console"

export default async function Page() {
  await billingGuard()
  return <CustomerPortalConsole />
}
