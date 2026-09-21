"use client"

import { useEffect, useState } from "react"
import { Plus, Scale } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  type LegalHold,
  createLegalHold,
  listLegalHolds,
  releaseLegalHold,
  subscribeGovernance,
} from "@/lib/governance-store"

function emptyDraft() {
  return { name: "", scope: "", records: "", createdBy: "" }
}

export function LegalHoldEditor() {
  const [holds, setHolds] = useState<LegalHold[]>([])
  const [creating, setCreating] = useState<ReturnType<typeof emptyDraft> | null>(null)
  const [releasing, setReleasing] = useState<{ id: string; reason: string } | null>(null)

  useEffect(() => {
    const refresh = () => setHolds(listLegalHolds())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function save() {
    if (!creating || !creating.name.trim() || !creating.scope.trim() || !creating.records.trim() || !creating.createdBy.trim())
      return
    createLegalHold(creating)
    setCreating(null)
  }

  function confirmRelease() {
    if (!releasing || !releasing.reason.trim()) return
    releaseLegalHold(releasing.id, "current.user@acme.com", releasing.reason.trim())
    setReleasing(null)
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Scale className="size-4 text-muted-foreground" />
              Legal holds
            </CardTitle>
            <CardDescription>
              Spec 72 — frontend-only editor. Active holds are meant to block retention archive/delete jobs and
              destructive bulk actions across every covered module once enforcement exists server-side.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(emptyDraft())}>
            <Plus className="size-3.5" />
            New hold
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hold</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holds.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="text-sm font-medium">{h.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {h.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[16rem] text-xs text-muted-foreground">{h.records}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.createdBy}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.start}</TableCell>
                  <TableCell>
                    <Badge variant={h.status === "Active" ? "destructive" : "secondary"} className="text-[10px]">
                      {h.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {h.status === "Active" ? (
                      <Button variant="ghost" size="sm" onClick={() => setReleasing({ id: h.id, reason: "" })}>
                        Release
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground" title={h.releasedBy ?? undefined}>
                        Released
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New legal hold</DialogTitle>
            <DialogDescription>Describe what is held and why.</DialogDescription>
          </DialogHeader>
          {creating && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="lh-name">Hold name</Label>
                <Input
                  id="lh-name"
                  value={creating.name}
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  placeholder="e.g. Litigation — Vendor dispute #2291"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lh-scope">Scope (module)</Label>
                <Input
                  id="lh-scope"
                  value={creating.scope}
                  onChange={(e) => setCreating({ ...creating, scope: e.target.value })}
                  placeholder="e.g. Finance"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lh-records">Records covered</Label>
                <Textarea
                  id="lh-records"
                  value={creating.records}
                  onChange={(e) => setCreating({ ...creating, records: e.target.value })}
                  placeholder="e.g. Vendor VEN-0044, all POs & invoices 2024–2026"
                  rows={2}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lh-created-by">Created by</Label>
                <Input
                  id="lh-created-by"
                  value={creating.createdBy}
                  onChange={(e) => setCreating({ ...creating, createdBy: e.target.value })}
                  placeholder="e.g. legal.counsel@acme.com"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Create hold</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={releasing !== null} onOpenChange={(open) => !open && setReleasing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Release legal hold</DialogTitle>
            <DialogDescription>Record why this hold is being released. This becomes part of the audit trail.</DialogDescription>
          </DialogHeader>
          {releasing && (
            <div className="grid gap-2">
              <Label htmlFor="lh-release-reason">Release reason</Label>
              <Textarea
                id="lh-release-reason"
                value={releasing.reason}
                onChange={(e) => setReleasing({ ...releasing, reason: e.target.value })}
                placeholder="e.g. dispute settled"
                rows={2}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleasing(null)}>
              Cancel
            </Button>
            <Button onClick={confirmRelease} disabled={!releasing?.reason.trim()}>
              Release hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
