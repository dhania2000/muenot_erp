import { requirePlatformStaff } from "@/lib/platform-guard"
import { PlatformCustomerSuccess } from "@/components/customer-success/platform-customer-success"

export const dynamic = "force-dynamic"
export const metadata = { title: "Customer success · Platform" }

export default async function Page() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return <p>Platform staff access is required.</p>
  return <PlatformCustomerSuccess />
}
