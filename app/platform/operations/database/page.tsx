import { Database } from "lucide-react"
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

// SPEC 79 — Database Monitoring (UI). Structural/connection facts the app
// can know without a live metrics pipeline; query-level performance metrics
// are marked as requiring the database provider's own monitoring.
const FACTS = [
  { label: "Provider", value: "Neon (see Vars for connection string)" },
  { label: "Connection pooling", value: "Enabled (pooled connection string)" },
  { label: "SSL mode", value: "require" },
]

const SLOW_QUERY_NOTE =
  "Query-level performance (slow query log, lock waits, index usage) is reported by the database provider's own monitoring dashboard, not duplicated here."

export default function DatabaseMonitoringPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Database monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Connection-level facts this application can observe directly. Query performance detail is deferred to
          the database provider.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4 text-muted-foreground" />
            Connection configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {FACTS.map((f) => (
                <TableRow key={f.label}>
                  <TableCell className="w-52 text-sm font-medium">{f.label}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{f.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Query performance</CardTitle>
          <CardDescription>{SLOW_QUERY_NOTE}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between pt-4">
          <p className="text-sm text-muted-foreground">Slow query log, index usage, lock waits</p>
          <Badge variant="outline" className="text-[10px]">
            View in provider dashboard
          </Badge>
        </CardContent>
      </Card>
    </div>
  )
}
