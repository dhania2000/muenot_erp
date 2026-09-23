"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Copy, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
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

const API = "/api/admin/security/access-policies"
const fetcher = (url: string) => fetch(url).then((r) => r.json())

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

function toPayload(policy: Policy) {
  return {
    name: policy.name,
    priority: policy.priority,
    scope: policy.scope,
    combinator: policy.combinator,
    effect: policy.effect,
    enabled: policy.enabled,
    conditions: policy.conditions,
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
  const { data, isLoading, mutate } = useSWR<{ policies: Policy[] }>(API, fetcher)
  const [editing, setEditing] = useState<Policy | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const policies = data?.policies ?? []
  const sorted = useMemo(() => [...policies].sort((a, b) => a.priority - b.priority), [policies])
  const isPersisted = (id: string) => policies.some((p) => p.id === id)

  function openNew() {
    setEditing(emptyPolicy())
  }

  function openEdit(p: Policy) {
    setEditing({ ...p, conditions: p.conditions.map((c) => ({ ...c })) })
  }

  async function duplicate(p: Policy) {
    setBusyId(p.id)
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload({ ...p, name: `${p.name} (copy)` })),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Failed to duplicate")
      toast.success("Policy duplicated")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function toggleEnabled(p: Policy) {
    setBusyId(p.id)
    // Optimistic update while the request is in flight.
    mutate(
      { policies: policies.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)) },
      { revalidate: false },
    )
    try {
      const res = await fetch(`${API}/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload({ ...p, enabled: !p.enabled })),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Failed to update")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
      mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string) {
    setBusyId(id)
    try {
      const res = await fetch(`${API}/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      toast.success("Policy deleted")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
      setDeletingId(null)
    }
  }

  async function save() {
    if (!editing) return
    setSaving(true)
    try {
      const persisted = isPersisted(editing.id)
      const res = await fetch(persisted ? `${API}/${editing.id}` : API, {
        method: persisted ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload(editing)),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save policy")
      toast.success(persisted ? "Policy updated" : "Policy created")
      setEditing(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
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
          <CardDescription>
            Spec 63 — evaluated in priority order at sign-in. Allow/Deny and MFA/re-authentication obligations are
            enforced by the login flow.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openNew} className="gap-1.5">
          <Plus className="size-3.5" /> New policy
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : sorted.length === 0 ? (
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
                          disabled={busyId === p.id}
                          onClick={() => duplicate(p)}
                        >
                          <Copy className="size-4" />
                        </Button>
                        <Switch
                          checked={p.enabled}
                          disabled={busyId === p.id}
                          onCheckedChange={() => toggleEnabled(p)}
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
            <DialogTitle>{editing && isPersisted(editing.id) ? "Edit policy" : "New policy"}</DialogTitle>
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

                {editing.conditions.map((c) => (
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
            <Button onClick={save} disabled={saving || !editing?.name.trim()}>
              {saving ? "Saving…" : "Save policy"}
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
