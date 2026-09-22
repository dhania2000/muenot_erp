"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Monitor, LogOut, Loader2 } from "lucide-react"
import { EmptyState } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import type { PublicSession } from "@/lib/session-store"

function formatRelative(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function formatAbsolute(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function SessionsClient({ initialSessions }: { initialSessions: PublicSession[] }) {
  const router = useRouter()
  const [sessions, setSessions] = useState(initialSessions)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [signingOutAll, setSigningOutAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function revoke(sessionId: string) {
    setBusyId(sessionId)
    setError(null)
    try {
      const res = await fetch(`/api/admin/security/sessions/${sessionId}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to end session")
      }
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to end session")
    } finally {
      setBusyId(null)
    }
  }

  async function signOutAll() {
    setSigningOutAll(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/security/sessions", { method: "POST" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to sign out sessions")
      }
      setSessions((prev) => prev.filter((s) => s.isCurrent))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign out sessions")
    } finally {
      setSigningOutAll(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          onClick={signOutAll}
          disabled={signingOutAll || sessions.filter((s) => !s.isCurrent).length === 0}
        >
          {signingOutAll ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
          Sign out all other sessions
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Monitor className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Active sessions</CardTitle>
          </div>
          <CardDescription>{sessions.length} active session{sessions.length === 1 ? "" : "s"} across your tenant</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>IP address</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Login time</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState icon={<Monitor className="size-5" />} title="No active sessions">
                        Sessions appear here once someone signs in.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((s) => (
                    <TableRow key={s.sessionId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{s.userName}</span>
                          <span className="text-xs text-muted-foreground">{s.userEmail}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col text-sm">
                          <span>{s.device}</span>
                          <span className="text-xs text-muted-foreground">{s.browser}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{s.ipAddress || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{s.loginMethod}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatAbsolute(s.createdAt)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatRelative(s.lastActiveAt)}</TableCell>
                      <TableCell className="text-right">
                        {s.isCurrent ? (
                          <Badge variant="secondary">This device</Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => revoke(s.sessionId)}
                            disabled={busyId === s.sessionId}
                          >
                            {busyId === s.sessionId ? <Loader2 className="size-4 animate-spin" /> : "End session"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
