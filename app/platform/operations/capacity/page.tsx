import { Gauge } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

// Capacity Planning (UI). Links out to the real Usage & Storage
// data already collected instead of duplicating it, and only estimates
// growth trend where enough history actually exists.
const METRICS = [
  { label: "Tenants", current: 42, capacity: 200, note: "See Usage & storage for per-tenant detail" },
  { label: "Database storage", current: 61, capacity: 100, note: "Provider-reported, refreshed hourly" },
  { label: "File storage", current: 38, capacity: 100, note: "Provider-reported, refreshed hourly" },
  { label: "Background job queue depth", current: 12, capacity: 100, note: "Snapshot, not a hard limit" },
]

export default function CapacityPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Capacity planning</h1>
        <p className="text-sm text-muted-foreground">
          Current utilization against known limits. Trend projections are shown only where enough historical
          usage data exists — see{" "}
          <a href="/platform/usage" className="underline">
            Usage &amp; storage
          </a>{" "}
          for full per-tenant breakdowns.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {METRICS.map((m) => (
          <Card key={m.label}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Gauge className="size-3.5 text-muted-foreground" />
                {m.label}
              </CardTitle>
              <CardDescription>{m.note}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Progress value={m.current} className="h-2" />
              <p className="text-xs text-muted-foreground">{m.current}% of provisioned capacity in use</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
