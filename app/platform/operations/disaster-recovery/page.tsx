import { LifeBuoy } from "lucide-react"
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

// SPEC 76 — Disaster Recovery (UI). Readiness is never claimed without
// supporting data — every service reports UNKNOWN until a drill/backup
// dependency actually exists.
const SERVICES = [
  { service: "Primary database", rpo: "—", rto: "—", method: "—", backupDependency: "Backups: NOT CONFIGURED", failover: "—", lastDrill: "—", lastRestoreTest: "—", readiness: "Unknown" },
  { service: "File / object storage", rpo: "—", rto: "—", method: "—", backupDependency: "Backups: NOT CONFIGURED", failover: "—", lastDrill: "—", lastRestoreTest: "—", readiness: "Unknown" },
  { service: "Application tier", rpo: "—", rto: "—", method: "—", backupDependency: "N/A (stateless)", failover: "—", lastDrill: "—", lastRestoreTest: "—", readiness: "Unknown" },
]

export default function DisasterRecoveryPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Disaster recovery</h1>
        <p className="text-sm text-muted-foreground">
          Recovery objectives and readiness per service. Readiness is reported honestly — it cannot show
          &quot;ready&quot; without a completed drill and a configured backup dependency.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <LifeBuoy className="size-4 text-muted-foreground" />
            Service recovery plan
          </CardTitle>
          <CardDescription>RPO/RTO, failover method, and last verified drill per service.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>RPO</TableHead>
                <TableHead>RTO</TableHead>
                <TableHead>Recovery method</TableHead>
                <TableHead>Backup dependency</TableHead>
                <TableHead>Failover</TableHead>
                <TableHead>Last drill</TableHead>
                <TableHead>Last restore test</TableHead>
                <TableHead className="text-right">Readiness</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SERVICES.map((s) => (
                <TableRow key={s.service}>
                  <TableCell className="text-sm font-medium">{s.service}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.rpo}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.rto}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.method}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.backupDependency}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.failover}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.lastDrill}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.lastRestoreTest}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className="text-[10px]">
                      {s.readiness}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
