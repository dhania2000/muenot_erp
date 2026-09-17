import { ShieldAlert } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { listAuditLog } from "@/lib/platform-metrics"
import { formatDateTime, humanizeAction } from "@/lib/platform-format"
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

const SECURITY_ACTIONS = new Set([
  "impersonation_start",
  "impersonation_stop",
  "assign_platform_role",
  "assign_tenant_role",
  "tenant_status_change",
])

function detailSummary(detail: Record<string, unknown> | null): string {
  if (!detail) return "—"
  return Object.entries(detail)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")
}

export default async function SecurityPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const entries = await listAuditLog(200)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Security &amp; audit</h1>
        <p className="text-sm text-muted-foreground">
          The immutable platform audit log. Security-relevant actions — impersonation and privilege changes — are
          highlighted.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" />
            Audit log
          </CardTitle>
          <CardDescription>{entries.length} most recent entries.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No audit entries recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => {
                  const security = SECURITY_ACTIONS.has(e.action)
                  return (
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{humanizeAction(e.action)}</span>
                          {security ? (
                            <Badge variant="destructive" className="text-[10px]">
                              Security
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {e.actor_email ?? `User #${e.actor_user_id}`}
                      </TableCell>
                      <TableCell className="max-w-[24rem] truncate text-xs text-muted-foreground">
                        {detailSummary(e.detail)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                        {formatDateTime(e.created_at)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
