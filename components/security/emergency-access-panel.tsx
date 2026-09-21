"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"
import {
  createEmergencyRequest,
  expireStaleRequests,
  listEmergencyRequests,
  revokeEmergencyRequest,
  subscribeEmergencyAccess,
  type EmergencyRequest,
  type EmergencyStatus,
} from "@/lib/emergency-access-store"

const DURATIONS = [
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "Custom", minutes: -1 },
]

const STATUS_BADGE: Record<EmergencyStatus, string> = {
  requested: "border-transparent bg-amber-600 text-white",
  approved: "border-transparent bg-blue-600 text-white",
  active: "border-transparent bg-destructive text-white",
  expired: "border-transparent bg-muted-foreground/70 text-background",
  revoked: "border-transparent bg-muted-foreground/70 text-background",
  rejected: "border-transparent bg-muted-foreground/70 text-background",
}

function formatTime(ts: number | null) {
  if (!ts) return "—"
  return new Date(ts).toLocaleString()
}

function formatRemaining(expiresAt: number | null) {
  if (!expiresAt) return "—"
  const ms = Math.max(0, expiresAt - Date.now())
  const mins = Math.floor(ms / 60_000)
  return `${mins} min`
}

export function EmergencyAccessPanel({ currentUser = "Signed-in admin" }: { currentUser?: string }) {
  const [requests, setRequests] = useState<EmergencyRequest[]>([])
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState("")
  const [justification, setJustification] = useState("")
  const [durationMinutes, setDurationMinutes] = useState(30)
  const [customMinutes, setCustomMinutes] = useState(45)
  const [approver, setApprover] = useState("")
  const [notify, setNotify] = useState(true)

  useEffect(() => {
    function refresh() {
      expireStaleRequests()
      setRequests(listEmergencyRequests())
    }
    refresh()
    const unsubscribe = subscribeEmergencyAccess(refresh)
    const interval = setInterval(refresh, 5000)
    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [])

  const active = requests.filter((r) => r.status === "active")
  const history = requests.filter((r) => r.status !== "active")

  function submit() {
    const minutes = durationMinutes === -1 ? customMinutes : durationMinutes
    createEmergencyRequest({
      requester: currentUser,
      scope: scope.trim() || "Unspecified scope",
      justification: justification.trim(),
      durationMinutes: minutes,
      approver: approver.trim() || "Pending approver",
      notifySecurity: notify,
    })
    setOpen(false)
    setScope("")
    setJustification("")
    setApprover("")
    setDurationMinutes(30)
  }

  return (
    <div className="space-y-6">
      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <p className="text-destructive-foreground">
          Emergency (break-glass) access grants temporary, elevated permissions outside normal role checks. Use
          only for active incidents. Every request requires justification, is time-boxed, and is fully audited.
        </p>
      </div>

      <div className="flex justify-end">
        <Button className="gap-1.5" onClick={() => setOpen(true)}>
          <ShieldAlert className="size-4" /> Request emergency access
        </Button>
      </div>

      {active.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active emergency access</CardTitle>
            <CardDescription>Currently elevated sessions. Revoke immediately if no longer needed.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Approver</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Time remaining</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {active.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.requester}</TableCell>
                      <TableCell>{r.scope}</TableCell>
                      <TableCell className="text-muted-foreground">{r.approver}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(r.startedAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(r.expiresAt)}</TableCell>
                      <TableCell>{formatRemaining(r.expiresAt)}</TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[r.status]}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => revokeEmergencyRequest(r.id, "Revoked by admin")}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Emergency access history</CardTitle>
          </div>
          <CardDescription>Every past request, approval, and outcome for audit.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={<ShieldAlert className="size-5" />} title="No completed emergency access requests">
                Past grants — expired, revoked, or rejected — will be listed here for audit.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requester</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Ended</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.requester}</TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">{r.justification || "—"}</TableCell>
                      <TableCell>{r.scope}</TableCell>
                      <TableCell className="text-muted-foreground">{r.approver}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(r.startedAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(r.endedAt)}</TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[r.status]}>{r.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request emergency access</DialogTitle>
            <DialogDescription>
              This request is logged and time-boxed. Access ends automatically at expiry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="ea-scope">Requested scope</Label>
              <Input
                id="ea-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="e.g. Finance module — read/write"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ea-justification">Justification</Label>
              <Textarea
                id="ea-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Describe the incident and why elevated access is required"
                rows={3}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="ea-duration">Duration</Label>
                <Select value={String(durationMinutes)} onValueChange={(v) => setDurationMinutes(Number(v))}>
                  <SelectTrigger id="ea-duration" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d.label} value={String(d.minutes)}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {durationMinutes === -1 && (
                <div className="grid gap-2">
                  <Label htmlFor="ea-custom">Custom minutes</Label>
                  <Input
                    id="ea-custom"
                    type="number"
                    min={1}
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Number(e.target.value) || 1)}
                  />
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ea-approver">Approver</Label>
              <Input
                id="ea-approver"
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Name of second approver"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notify} onCheckedChange={(v) => setNotify(Boolean(v))} />
              Notify security team
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!justification.trim()}>
              Submit request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
