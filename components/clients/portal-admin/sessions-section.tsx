"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { EmptyState, KpiCard, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { SESSIONS } from "./data"
import { MonitorSmartphone } from "lucide-react"

export function SessionsSection() {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SESSIONS
    return SESSIONS.filter((s) =>
      [s.user, s.client, s.device, s.browser, s.location, s.ip].some((v) => v.toLowerCase().includes(q)),
    )
  }, [query])

  const active = SESSIONS.filter((s) => s.status === "active").length
  const idle = SESSIONS.filter((s) => s.status === "idle").length

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Active Sessions"
        description="Live and recent portal sessions across all clients. Revoke any session to force sign-out."
        actions={
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="destructive">Revoke all sessions</Button>} />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke all sessions?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every portal user across all clients will be signed out immediately. They will need to log in again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => toast.success("All sessions revoked")}>Revoke all</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Active now" value={active} tone="positive" />
        <KpiCard label="Idle" value={idle} tone="warning" />
        <KpiCard label="Total tracked" value={SESSIONS.length} />
      </div>

      <SearchInput value={query} onChange={setQuery} placeholder="Search sessions…" className="w-full sm:w-72" />

      {filtered.length === 0 ? (
        <EmptyState icon={MonitorSmartphone} title="No sessions" description="Active portal sessions will appear here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Device / Browser</TableHead>
                <TableHead>Location / IP</TableHead>
                <TableHead>Login time</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{s.user}</span>
                      <span className="text-xs text-muted-foreground">{s.client}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{s.device} · {s.browser}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.location} · {s.ip}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.loginTime}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.lastActivity}</TableCell>
                  <TableCell>
                    <StatusBadge label={s.status} tone={portalStatusTone(s.status)} className="capitalize" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="xs" variant="outline" onClick={() => toast.success(`Session revoked — ${s.user}`)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
