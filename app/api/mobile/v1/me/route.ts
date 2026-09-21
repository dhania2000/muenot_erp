import { getTenantById } from "@/lib/tenant-service"
import { getTenantFeatureMap } from "@/lib/platform/feature-guard"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request: Request) { const result = await withMobileAuth(request, async p => { const tenant = await getTenantById(p.tenantId); return mobileJson({ user: { id:p.userId,name:p.name,email:p.email,role:p.role,tenantRole:p.tenantRole }, tenant: tenant && { id:tenant.id,name:tenant.name,slug:tenant.slug,tenantType:tenant.tenant_type,status:tenant.status }, entitlements: await getTenantFeatureMap(p.tenantId) }) }); return isMobileResponse(result) ? result : result }
