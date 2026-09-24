import Link from "next/link"
import { getPortalSession } from "@/lib/portal/auth"
import { getClientResources } from "@/lib/portal/access"
import { countItemsByResource, listTickets } from "@/lib/portal/store"
import { PORTAL_RESOURCE_META, isPortalItemResource } from "@/lib/portal/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function PortalDashboardPage() {
  const session = await getPortalSession()
  if (!session) return null

  const resources = await getClientResources(session.tenantId, session.clientId)
  const [counts, tickets] = await Promise.all([
    countItemsByResource(session.tenantId, session.clientId),
    resources.includes("tickets")
      ? listTickets(session.tenantId, session.clientId)
      : Promise.resolve([]),
  ])
  const openTickets = tickets.filter((t) => t.status === "open" || t.status === "pending").length

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.name}</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s an overview of everything shared with you.</p>
      </div>

      {resources.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don&apos;t have access to any sections yet. Please contact your account team.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((r) => {
            const meta = PORTAL_RESOURCE_META[r]
            let value: string
            if (r === "tickets") value = `${openTickets} open`
            else if (r === "messages") value = "View thread"
            else if (isPortalItemResource(r)) value = `${counts[r] ?? 0} ${counts[r] === 1 ? "item" : "items"}`
            else value = ""
            return (
              <Link key={r} href={`/portal/${r}`} className="group">
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
