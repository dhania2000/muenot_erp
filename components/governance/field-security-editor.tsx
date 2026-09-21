"use client"

import { useEffect, useState } from "react"
import { Lock, Pencil, Plus, Trash2 } from "lucide-react"
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
  type FieldEffect,
  type FieldSecurityPolicy,
  deleteFieldSecurityPolicy,
  listFieldSecurityPolicies,
  subscribeGovernance,
  upsertFieldSecurityPolicy,
} from "@/lib/governance-store"

const EFFECTS: FieldEffect[] = ["Visible", "Read Only", "Masked", "Hidden"]
const EFFECT_TONE: Record<FieldEffect, "secondary" | "outline" | "destructive"> = {
  Visible: "secondary",
  "Read Only": "outline",
  Masked: "outline",
  Hidden: "destructive",
}

function emptyDraft(): Omit<FieldSecurityPolicy, "id" | "createdAt"> {
  return { module: "", entity: "", field: "", scope: "", effect: "Masked" }
}

export function FieldSecurityEditor() {
  const [policies, setPolicies] = useState<FieldSecurityPolicy[]>([])
  const [editing, setEditing] = useState<(Partial<FieldSecurityPolicy> & { isNew: boolean }) | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => setPolicies(listFieldSecurityPolicies())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function save() {
    if (!editing || !editing.module?.trim() || !editing.entity?.trim() || !editing.field?.trim() || !editing.scope?.trim())
      return
    upsertFieldSecurityPolicy({
      id: editing.isNew ? undefined : editing.id,
      module: editing.module.trim(),
      entity: editing.entity.trim(),
      field: editing.field.trim(),
      scope: editing.scope.trim(),
      effect: (editing.effect as FieldEffect) ?? "Masked",
    })
    setEditing(null)
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              Field access policies
            </CardTitle>
            <CardDescription>
              Spec 70 — frontend-only editor. Real enforcement must happen server-side on API responses, exports,
              and reports, never as frontend-only masking.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setEditing({ ...emptyDraft(), isNew: true })}>
            <Plus className="size-3.5" />
            New policy
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Effect</TableHead>
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
                  <TableCell className="text-sm">{p.entity}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.field}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.scope}</TableCell>
                  <TableCell>
                    <Badge variant={EFFECT_TONE[p.effect]} className="text-[10px]">
                      {p.effect}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${p.field}`}
                        onClick={() => setEditing({ ...p, isNew: false })}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${p.field}`}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sensitive field examples covered</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5 pt-0">
          {["Salary", "Bank details", "PAN", "Tax information", "Personal identifiers", "Internal finance data"].map(
            (t) => (
              <Badge key={t} variant="outline" className="text-[10px]">
                {t}
              </Badge>
            ),
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? "New policy" : "Edit policy"}</DialogTitle>
            <DialogDescription>Set the access effect for a field within a given scope.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="fs-module">Module</Label>
                <Input
                  id="fs-module"
                  value={editing.module ?? ""}
                  onChange={(e) => setEditing({ ...editing, module: e.target.value })}
                  placeholder="e.g. HR"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-entity">Entity</Label>
                <Input
                  id="fs-entity"
                  value={editing.entity ?? ""}
                  onChange={(e) => setEditing({ ...editing, entity: e.target.value })}
                  placeholder="e.g. Employee"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-field">Field</Label>
                <Input
                  id="fs-field"
                  value={editing.field ?? ""}
                  onChange={(e) => setEditing({ ...editing, field: e.target.value })}
                  placeholder="e.g. Salary (CTC)"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-scope">Scope</Label>
                <Input
                  id="fs-scope"
                  value={editing.scope ?? ""}
                  onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
                  placeholder="e.g. Role: Manager"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-effect">Effect</Label>
                <Select
                  value={editing.effect ?? "Masked"}
                  onValueChange={(v) => setEditing({ ...editing, effect: v as FieldEffect })}
                >
                  <SelectTrigger id="fs-effect" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFECTS.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
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
                if (deletingId) deleteFieldSecurityPolicy(deletingId)
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
