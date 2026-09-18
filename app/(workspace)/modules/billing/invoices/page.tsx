import { billingGuard } from "@/lib/billing-guard"
import { InvoiceConsole } from "@/components/billing/invoice-console"

export default async function Page() {
  await billingGuard()
  return <InvoiceConsole />
}
