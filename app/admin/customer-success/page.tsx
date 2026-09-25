import { requireTenantAdmin } from "@/lib/platform-guard"
import { TenantCustomerSuccess } from "@/components/customer-success/tenant-customer-success"

export const dynamic = "force-dynamic"
export const metadata = { title: "Customer health" }

export default async function Page() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p>Tenant administrator access is required.</p>
  return <TenantCustomerSuccess />
}
