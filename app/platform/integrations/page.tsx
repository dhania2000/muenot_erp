import { Plug } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getIntegrations } from "@/lib/platform-metrics"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

export default async function IntegrationsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const integrations = getIntegrations()
  const connected = integrations.filter((i) => i.connected).length

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Platform service connections, detected live from the environment. {connected} of {integrations.length}{" "}
          connected.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((i) => (
          <Card key={i.name}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Plug className="size-4" />
                  </span>
                  <div className="flex flex-col">
                    <CardTitle className="text-base">{i.name}</CardTitle>
                    <CardDescription>{i.category}</CardDescription>
                  </div>
                </div>
                <Badge variant={i.connected ? "default" : "secondary"}>
                  {i.connected ? "Connected" : "Not set"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{i.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
