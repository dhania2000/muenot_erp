"use client"

import { useMemo, useState } from "react"
import { Copy, Pencil, Plus, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"

const CONDITION_FIELDS = [
  "User",
  "Role",
  "Module",
  "Resource",
  "IP condition",
  "Country",
  "Device trust",
  "MFA state",
  "Session age",
  "Time window",
] as const

const OPERATORS = ["=", "!=", "in", "not in", "contains"] as const
const EFFECTS = ["Allow", "Deny", "Require MFA", "Require re-authentication"] as const
const SCOPES = ["Platform", "Tenant", "Module", "Resource"] as const

type Condition = { id: string; field: string; operator: string; value: string }
type Effect = (typeof EFFECTS)[number]
type Policy = {
  id: string
  name: string
  priority: number
  scope: string
  conditions: Condition[]
  combinator: "AND" | "OR"
  effect: Effect
  enabled: boolean
}

function newCondition(): Condition {
  return { id: crypto.randomUUID(), field: CONDITION_FIELDS[0], operator: OPERATORS[0], value: "" }
}

function emptyPolicy(): Policy {
  return {
    id: crypto.randomUUID(),
    name: "",
    priority: 100,
    scope: SCOPES[1],
    conditions: [newCondition()],
    combinator: "AND",
    effect: "Allow",
    enabled: true,
  }
}

function effectBadgeClass(effect: Effect) {
  switch (effect) {
    case "Allow":
      return "border-transparent bg-emerald-600 text-white"
    case "Deny":
      return "border-transparent bg-destructive text-white"
    default:
      return "border-transparent bg-amber-600 text-white"
  }
}

function PolicyPreview({ policy }: { policy: Policy }) {
  const conditionText = policy.conditions
    .filter((c) => c.value.trim() !== "" || c.field)
    .map((c) => `${c.field} ${c.operator} ${c.value || "…"}`)
  return (
    <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      <p className="text-muted-foreground">WHEN</p>
      {conditionText.length === 0 ? (
        <p>(no conditions)</p>
      ) : (
        conditionText.map((line, i) => (
          <p key={i}>
            {i > 0 && <span className="text-muted-foreground">{policy.combinator} </span>}
            {line}
          </p>
        ))
      )}
      <p className="mt-1 text-muted-foreground">THEN</p>
      <p>{policy.effect}</p>
    </div>
  )
}

export function AccessPolicyBuilder() {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [editing, setEditing] = useState<Policy | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const sorted = useMemo(() => [...policies].sort((a, b) => a.priority - b.priority), [policies])

  function openNew() {
    setEditing(emptyPolicy())
  }

  function openEdit(p: Policy) {
    setEditing({ ...p, conditions: p.conditions.map((c) => ({ ...c })) })
  }

  function duplicate(p: Policy) {
    setPolicies((all) => [
      ...all,
      { ...p, id: crypto.randomUUID(), name: `${p.name} (copy)`, conditions: p.conditions.map((c) => ({ ...c })) },
    ])
  }

  function toggleEnabled(id: string) {
    setPolicies((all) => all.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)))
  }

  function remove(id: string) {
    setPolicies((all) => all.filter((p) => p.id !== id))
    setDeletingId(null)
  }

  function save() {
    if (!editing) return
    setPolicies((all) => {
      const exists = all.some((p) => p.id === editing.id)
      return exists ? all.map((p) => (p.id === editing.id ? editing : p)) : [...all, editing]
    })
    setEditing(null)
  }

  function updateCondition(id: string, patch: Partial<Condition>) {
    if (!editing) return
    setEditing({
      ...editing,
      conditions: editing.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Conditional access policies</CardTitle>
          <CardDescription>Spec 63 — evaluated in priority order. Codex will wire enforcement.</CardDescription>
        </div>
        <Button size="sm" onClick={openNew} className="gap-1.5">
          <Plus className="size-3.5" /> New policy
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {sorted.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<Plus className="size-5" />} title="No conditional access policies yet">
              Create a policy to allow, deny, or require MFA/re-authentication based on role, location, device
              trust, or session conditions.
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Policy name</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Conditions</TableHead>
                  <TableHead>Effect</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name || "Untitled policy"}</TableCell>
                    <TableCell>{p.priority}</TableCell>
                    <TableCell className="text-muted-foreground">{p.scope}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.conditions.length} condition{p.conditions.length === 1 ? "" : "s"} ({p.combinator})
                    </TableCell>
                    <TableCell>
                      <Badge className={effectBadgeClass(p.effect)}>{p.effect}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.enabled ? "default" : "outline"}>{p.enabled ? "Enabled" : "Disabled"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Duplicate ${p.name}`}
                          onClick={() => duplicate(p)}
                        >
                          <Copy className="size-4" />
                        </Button>
                        <Switch
                          checked={p.enabled}
                          onCheckedChange={() => toggleEnabled(p.id)}
                          aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${p.name}`}
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
          </div>
        )}
      </CardContent>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing && policies.some((p) => p.id === editing.id) ? "Edit policy" : "New policy"}</DialogTitle>
            <DialogDescription>Define when this policy applies and what it does.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="policy-name">Policy name</Label>
                  <Input
                    id="policy-name"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="e.g. Require MFA outside allowed countries"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="policy-priority">Priority</Label>
                  <Input
                    id="policy-priority"
                    type="number"
                    value={editing.priority}
                    onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="policy-scope">Scope</Label>
                  <Select value={editing.scope} onValueChange={(v) => setEditing({ ...editing, scope: v })}>
                    <SelectTrigger id="policy-scope" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-3 self-end rounded-md border p-2.5">
                  <span className="text-sm">Enabled</span>
                  <Switch
                    checked={editing.enabled}
                    onCheckedChange={(v) => setEditing({ ...editing, enabled: v })}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Conditions</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Combine with</span>
                    <Select
                      value={editing.combinator}
                      onValueChange={(v) => setEditing({ ...editing, combinator: v as "AND" | "OR" })}
                    >
                      <SelectTrigger className="h-8 w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AND">AND</SelectItem>
                        <SelectItem value="OR">OR</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {editing.conditions.map((c, i) => (
                  <div key={c.id} className="flex flex-wrap items-end gap-2 rounded-md border p-2.5">
                    <div className="grid gap-1">
                      <Label htmlFor={`cond-field-${c.id}`} className="text-xs">
                        Field
                      </Label>
                      <Select value={c.field} onValueChange={(v) => updateCondition(c.id, { field: v })}>
                        <SelectTrigger id={`cond-field-${c.id}`} className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_FIELDS.map((f) => (
                            <SelectItem key={f} value={f}>
                              {f}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`cond-op-${c.id}`} className="text-xs">
                        Operator
                      </Label>
                      <Select value={c.operator} onValueChange={(v) => updateCondition(c.id, { operator: v })}>
                        <SelectTrigger id={`cond-op-${c.id}`} className="h-8 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPERATORS.map((op) => (
                            <SelectItem key={op} value={op}>
                              {op}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid flex-1 gap-1">
                      <Label htmlFor={`cond-val-${c.id}`} className="text-xs">
                        Value
                      </Label>
                      <Input
                        id={`cond-val-${c.id}`}
                        className="h-8"
                        value={c.value}
                        onChange={(e) => updateCondition(c.id, { value: e.target.value })}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove condition"
                      onClick={() =>
                        setEditing({ ...editing, conditions: editing.conditions.filter((cc) => cc.id !== c.id) })
                      }
                      disabled={editing.conditions.length === 1}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setEditing({ ...editing, conditions: [...editing.conditions, newCondition()] })}
                >
                  <Plus className="size-3.5" /> Add condition
                </Button>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="policy-effect">Effect</Label>
                <Select value={editing.effect} onValueChange={(v) => setEditing({ ...editing, effect: v as Effect })}>
                  <SelectTrigger id="policy-effect" className="w-full sm:w-64">
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

              <div className="grid gap-2">
                <Label>Effective policy preview</Label>
                <PolicyPreview policy={editing} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!editing?.name.trim()}>
              Save policy
            </Button>
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
              onClick={() => deletingId && remove(deletingId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
