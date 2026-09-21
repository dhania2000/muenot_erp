import { getSubscriptionForTenant } from "@/lib/platform-console"
import { getEntitlementSnapshot } from "@/lib/platform/entitlement-guard"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async p=>mobileJson({subscription:await getSubscriptionForTenant(p.tenantId),...(await getEntitlementSnapshot(p.tenantId))}),"subscription");return isMobileResponse(result)?result:result}
