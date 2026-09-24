import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getTenantEntitlements } from "@/lib/platform/entitlement-guard"
import { hasFeatureFlag } from "@/lib/platform/entitlements"
import { CUSTOM_DOMAIN_FLAG, DOMAIN_CNAME_TARGET, TLS_ARCHITECTURE } from "@/lib/custom-domain"
import { listDomains } from "@/lib/custom-domain-store"
import { CustomDomainClient } from "@/components/admin/custom-domain-client"

export const dynamic = "force-dynamic"

// SPEC 157 — Custom Domain. Enterprise tenants can serve the workspace from
// their own hostname (e.g. erp.customer.com) with managed TLS. Backed by
// lib/custom-domain-store.ts and app/api/admin/custom-domain/*.
export default async function CustomDomainPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const entitled =
    tenant != null && hasFeatureFlag(await getTenantEntitlements(tenant.tenantId), CUSTOM_DOMAIN_FLAG)

  const domains = entitled ? await listDomains() : []

  return (
    <CustomDomainClient
      entitled={entitled}
      initialDomains={domains}
      cnameTarget={DOMAIN_CNAME_TARGET}
      tls={TLS_ARCHITECTURE}
    />
  )
}
