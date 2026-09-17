import { Activity, Clock, Server } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getSystemHealth, getScheduledJobs, getDeploymentInfo } from "@/lib/platform-metrics"
import { formatDuration } from "@/lib/platform-format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const dynamic = "force-dynamic"

const tone: Record<string, "default" | "secondary" | "destructive"> = {
  ok: "default",
  warn: "secondary",
  down: "destructive",
}

export default async function HealthPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [health, deployment] = await Promise.all([getSystemHealth(), Promise.resolve(getDeploymentInfo())])
  const jobs = getScheduledJobs()

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Health &amp; jobs</h1>
        <p className="text-sm text-muted-foreground">
          Live service checks, runtime information and the platform&apos;s scheduled jobs.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              Service checks
            </CardTitle>
            <CardDescription>
              Overall{" "}
              <Badge variant={tone[health.overall]} className="ml-1 capitalize">
                {health.overall}
              </Badge>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {health.checks.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-3 py-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.detail}</span>
                </div>
                <Badge variant={tone[c.status]} className="capitalize">
                  {c.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" />
              Runtime
            </CardTitle>
            <CardDescription>Process and deployment environment.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {[
              ["Environment", deployment.environment],
              ["Region", deployment.region],
              ["Node", health.runtime.nodeVersion],
              ["Platform", health.runtime.platform],
              ["Uptime", formatDuration(health.runtime.uptimeSeconds)],
              ["Branch", deployment.branch ?? "—"],
              ["Commit", deployment.commitSha ? deployment.commitSha.slice(0, 8) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-mono text-xs">{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              Scheduled jobs
            </CardTitle>
            <CardDescription>Cron-driven maintenance. Enabled reflects whether a cron secret is configured.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.name}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{j.name}</span>
                        <span className="text-xs text-muted-foreground">{j.description}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{j.schedule}</TableCell>
                    <TableCell>
                      <Badge variant={j.enabled ? "default" : "secondary"}>{j.enabled ? "Enabled" : "Inactive"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
