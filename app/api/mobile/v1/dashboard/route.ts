import { getPersonalDashboard } from "@/lib/personal-dashboard"
import { getShopkeeperDashboard } from "@/lib/shopkeeper-dashboard"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
import { getTenantById } from "@/lib/tenant-service"

export const runtime = "nodejs"

/**
 * SHOPKEEPER tenants get the shop home screen (orders, sales, customers,
 * WhatsApp); every other tenant type keeps the existing ERP personal
 * dashboard unchanged. The tenant type is read from the database using the
 * token's tenant id, never from the request.
 */
export async function GET(request: Request) {
  const result = await withMobileAuth(
    request,
    async (principal) => {
      const tenant = await getTenantById(principal.tenantId).catch(() => null)
      if (tenant?.tenant_type === "SHOPKEEPER") {
        return mobileJson({ type: "shopkeeper", ...(await getShopkeeperDashboard()) })
      }
      return mobileJson(await getPersonalDashboard(principal.userId, principal.name))
    },
    "mobile_app",
  )
  return isMobileResponse(result) ? result : result
}
