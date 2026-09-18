import { billingGuard } from "@/lib/billing-guard"
import { WebhookMonitor } from "@/components/billing/webhook-monitor"

export default async function Page() {
  await billingGuard()
  return <WebhookMonitor />
}
