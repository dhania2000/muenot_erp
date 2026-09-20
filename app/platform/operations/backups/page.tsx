import { Archive, Settings2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// SPEC 75 — Platform Backup Operations (UI). Honest NOT CONFIGURED state
// until an infrastructure backup provider is wired up — no fabricated
// success history is shown.
const TARGETS = [
  { name: "Database backup", configured: false },
  { name: "File / object storage backup", configured: false },
  { name: "Configuration backup", configured: false },
]

export default function BackupsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
        <p className="text-sm text-muted-foreground">
          Infrastructure-provider backup status for database, file storage, and configuration. Nothing here is
          fabricated — a target shows NOT CONFIGURED until a real provider is connected.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Archive className="size-4 text-muted-foreground" />
            Backup targets
          </CardTitle>
          <CardDescription>Authorized platform staff can configure a provider for each target.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Last backup</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Encryption</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Retention</TableHead>
                <TableHead>Last restore test</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TARGETS.map((t) => (
                <TableRow key={t.name}>
                  <TableCell className="text-sm font-medium">{t.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="destructive" className="text-[10px]">
                      NOT CONFIGURED
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <p className="text-sm text-muted-foreground">
            Connect a backup provider to start tracking real backup history for this platform.
          </p>
          <Button size="sm" variant="outline" className="gap-1.5 shrink-0">
            <Settings2 className="size-3.5" />
            Configure provider
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
