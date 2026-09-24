import { redirect } from "next/navigation"
import { requireFeature } from "@/lib/api-auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { countPortalPlacedOrdersByStatus, listPortalPlacedOrders } from "@/lib/portal/store"
import { PortalOrdersClient } from "@/components/sales/portal-orders-client"

export const dynamic = "force-dynamic"

export default async function SalesOrderManagementPage() {
  const session = await requireFeature("sales.view_quotations")
  if (!session) redirect("/modules/sales/dashboard")
  const tenantId = requireCurrentTenantId()

  const [orders, counts] = await Promise.all([
    listPortalPlacedOrders(tenantId),
    countPortalPlacedOrdersByStatus(tenantId),
  ])

  const canManage = await requireFeature("sales.manage_quotations")

  return (
    <PortalOrdersClient
      initialOrders={orders}
      initialCounts={counts}
      canManage={Boolean(canManage)}
    />
  )
}
