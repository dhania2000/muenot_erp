"use client"

import { useEffect, useState } from "react"
import { Pause, Play, Plus, Timer, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  type RetentionAction,
  type RetentionPolicy,
  deleteRetentionPolicy,
  listRetentionPolicies,
  runRetentionNow,
  subscribeGovernance,
  toggleRetentionPause,
  upsertRetentionPolicy,
} from "@/lib/governance-store"

const ACTIONS: RetentionAction[] = ["Archive", "Delete"]

function emptyDraft() {
  return { module: "", recordType: "", period: "", action: "Archive" as RetentionAction }
}

export function RetentionPolicyEditor() {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([])
  const [editing, setEditing] = useState<ReturnType<typeof emptyDraft> | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => setPolicies(listRetentionPolicies())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function save() {
    if (!editing || !editing.module.trim() || !editing.recordType.trim() || !editing.period.trim()) return
    upsertRetentionPolicy(editing)
    setEditing(null)
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Timer className="size-4 text-muted-foreground" />
              Retention policies
            </CardTitle>
            <CardDescription>
              Spec 71 — frontend-only editor. A real scheduled job would check active legal holds before archiving
              or deleting a record.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setEditing(emptyDraft())}>
            <Plus className="size-3.5" />
            New policy
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Record type</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Affected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {p.module}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{p.recordType}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.period}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.action}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.nextRun}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.lastRun}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.affected}</TableCell>
                  <TableCell>
                    <Badge variant={p.legalHold ? "destructive" : "secondary"} className="text-[10px]">
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Run ${p.recordType} now`}
                        disabled={p.legalHold}
                        onClick={() => runRetentionNow(p.id)}
                        title="Run now"
                      >
                        <Play className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={p.status === "Paused" ? `Resume ${p.recordType}` : `Pause ${p.recordType}`}
                        disabled={p.legalHold}
                        onClick={() => toggleRetentionPause(p.id)}
                        title={p.status === "Paused" ? "Resume" : "Pause"}
                      >
                        <Pause className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${p.recordType} policy`}
                        onClick={() => setDeletingId(p.id)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New retention policy</DialogTitle>
            <DialogDescription>Applies to a record type after the retention period elapses.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="rp-module">Module</Label>
                <Input
                  id="rp-module"
                  value={editing.module}
                  onChange={(e) => setEditing({ ...editing, module: e.target.value })}
                  placeholder="e.g. Finance"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rp-record-type">Record type</Label>
                <Input
                  id="rp-record-type"
                  value={editing.recordType}
                  onChange={(e) => setEditing({ ...editing, recordType: e.target.value })}
                  placeholder="e.g. Closed invoices"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rp-period">Retention period</Label>
                <Input
                  id="rp-period"
                  value={editing.period}
                  onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                  placeholder="e.g. 10 years"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rp-action">Action</Label>
                <Select
                  value={editing.action}
                  onValueChange={(v) => setEditing({ ...editing, action: v as RetentionAction })}
                >
                  <SelectTrigger id="rp-action" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Save policy</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this policy?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deletingId) deleteRetentionPolicy(deletingId)
                setDeletingId(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
