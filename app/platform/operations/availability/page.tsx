import { Activity } from "lucide-react"
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

// High Availability status (UI). Shows real deployment topology
// facts only; does not fabricate multi-region or failover claims that the
// platform does not actually implement.
const COMPONENTS = [
  { component: "Application (Next.js)", topology: "Single region, single instance", redundancy: "None", healthCheck: "Not configured", failoverTested: "—" },
  { component: "Primary database", topology: "Single region", redundancy: "Provider-managed (see integration)", healthCheck: "Not configured", failoverTested: "—" },
  { component: "File / object storage", topology: "Single region", redundancy: "Provider-managed (see integration)", healthCheck: "Not configured", failoverTested: "—" },
]

export default function AvailabilityPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Availability</h1>
        <p className="text-sm text-muted-foreground">
          Deployment topology and redundancy per component, reported as-is. No SLA, uptime percentage, or
          multi-region failover claim is shown unless it reflects the actual infrastructure.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Component topology
          </CardTitle>
          <CardDescription>Redundancy for managed dependencies is controlled by their provider integration.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>Topology</TableHead>
                <TableHead>Redundancy</TableHead>
                <TableHead>Health check</TableHead>
                <TableHead className="text-right">Failover tested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPONENTS.map((c) => (
                <TableRow key={c.component}>
                  <TableCell className="text-sm font-medium">{c.component}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.topology}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.redundancy}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {c.healthCheck}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{c.failoverTested}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
