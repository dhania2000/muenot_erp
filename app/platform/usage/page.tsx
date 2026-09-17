import { Database, HardDrive, Users } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getUsageMetrics, getStorageBreakdown } from "@/lib/platform-metrics"
import { formatBytes, formatNumber } from "@/lib/platform-format"
import { StatCard } from "@/components/platform/stat-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
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

export default async function UsagePage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [usage, storage] = await Promise.all([getUsageMetrics(), getStorageBreakdown()])
  const maxTableBytes = storage.tables[0]?.bytes ?? 0

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Usage &amp; storage</h1>
        <p className="text-sm text-muted-foreground">
          Live seat occupancy per tenant and real database storage from the information schema.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total users" value={formatNumber(usage.totalUsers)} icon={Users} />
        <StatCard label="Database size" value={formatBytes(storage.totalBytes)} hint={`${storage.tableCount} tables`} icon={Database} />
        <StatCard label="Row estimate" value={formatNumber(storage.rowEstimate)} icon={HardDrive} />
      </section>

      <section>
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Seat occupancy by tenant</CardTitle>
            <CardDescription>Active users against each tenant&apos;s plan seat limit.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Users</TableHead>
                  <TableHead className="w-[40%]">Occupancy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.perTenant.map((t) => {
                  const pct = t.seatLimit ? Math.min(100, Math.round((t.users / t.seatLimit) * 100)) : null
                  const over = t.seatLimit != null && t.users > t.seatLimit
                  return (
                    <TableRow key={t.tenant_id}>
                      <TableCell className="font-medium">{t.tenant_name}</TableCell>
                      <TableCell className="capitalize text-muted-foreground">{t.planName}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatNumber(t.users)}
                        {t.seatLimit != null ? (
                          <span className="text-muted-foreground"> / {formatNumber(t.seatLimit)}</span>
                        ) : (
                          <span className="text-muted-foreground"> / ∞</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {pct == null ? (
                          <Badge variant="secondary">Unlimited</Badge>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Progress value={pct} className="h-2" />
                            <span className={"w-10 text-right text-xs tabular-nums " + (over ? "text-destructive" : "text-muted-foreground")}>
                              {pct}%
                            </span>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Storage by table</CardTitle>
            <CardDescription>Top tables by data + index size in the application database.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead className="w-[45%]">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {storage.tables.map((t) => {
                  const pct = maxTableBytes > 0 ? Math.round((t.bytes / maxTableBytes) * 100) : 0
                  return (
                    <TableRow key={t.name}>
                      <TableCell className="font-mono text-xs">{t.name}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{formatNumber(t.rows)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={pct} className="h-2" />
                          <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                            {formatBytes(t.bytes)}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
