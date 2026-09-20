import { Zap } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

// SPEC 80 — Cache Monitoring (UI). Honest NOT CONFIGURED state — this
// platform has no caching layer (e.g. Redis) connected yet, so no fabricated
// hit-rate or eviction metrics are shown.
export default function CacheMonitoringPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Cache monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Hit rate, memory usage, and eviction stats for the platform&apos;s caching layer.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Zap className="size-4 text-muted-foreground" />
            Caching layer
          </CardTitle>
          <CardDescription>
            No caching layer (e.g. Upstash for Redis) is connected to this project. Hit rate, memory, and
            eviction metrics will appear here once one is added.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between pt-4">
          <p className="text-sm text-muted-foreground">Status</p>
          <Badge variant="destructive" className="text-[10px]">
            NOT CONFIGURED
          </Badge>
        </CardContent>
      </Card>
    </div>
  )
}
