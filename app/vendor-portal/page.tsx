import Link from "next/link"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { getVendorResources } from "@/lib/vendor-portal/access"
import { countItemsByResource } from "@/lib/vendor-portal/store"
import { VENDOR_PORTAL_RESOURCE_META, isVendorPortalItemResource } from "@/lib/vendor-portal/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function VendorPortalDashboardPage() {
  const session = await getVendorPortalSession()
  if (!session) return null

  const [resources, counts] = await Promise.all([
    getVendorResources(session.tenantId, session.vendorId),
    countItemsByResource(session.tenantId, session.vendorId),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.name}</h1>
        <p className="text-sm text-muted-foreground">
          Here&apos;s an overview of everything shared with your organization.
        </p>
      </div>

      {resources.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don&apos;t have access to any sections yet. Please contact the accounts-payable team.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((r) => {
            const meta = VENDOR_PORTAL_RESOURCE_META[r]
            let value: string
            if (r === "messages") value = "View thread"
            else if (isVendorPortalItemResource(r)) value = `${counts[r] ?? 0} ${counts[r] === 1 ? "record" : "records"}`
            else value = ""
            return (
              <Link key={r} href={`/vendor-portal/${r}`} className="group">
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{meta.labelPlural}</CardTitle>
                    <CardDescription>{meta.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm font-medium text-primary">{value}</p>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
