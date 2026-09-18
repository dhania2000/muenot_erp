"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Plus, GitBranch, Trash2, Layers, UserCog, PlayCircle, ArrowRight } from "lucide-react"
import { toast } from "sonner"

type ApproverTarget = {
  kind: "user" | "role" | "department" | "entity" | "dynamic"
  userId?: number | null
  roleId?: number | null
  department?: string | null
  entityId?: number | null
  dynamic?: string | null
}

type RuleLevel = {
  sequence: number
  mode: "sequential" | "parallel"
  minApprovals: number
  approvers: ApproverTarget[]
}

type Rule = {
  id: number
  name: string
  description: string | null
  moduleKey: string
  active: boolean
  priority: number
  minAmount: number | null
  maxAmount: number | null
  department: string | null
  roleId: number | null
  entityId: number | null
  escalationHours: number | null
  levels: RuleLevel[]
  createdAt: string
}

type Options = {
  modules: { key: string; label: string }[]
  users: { id: number; name: string; email: string }[]
  roles: { id: number; name: string }[]
  entities: { id: number; name: string }[]
  departments: string[]
  dynamicApprovers: { value: string; label: string }[]
}

const EMPTY_LEVEL: RuleLevel = { sequence: 1, mode: "sequential", minApprovals: 1, approvers: [] }

export function ApprovalAuthorityManager() {
  return (
    <Tabs defaultValue="rules" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="rules" className="gap-1.5">
          <GitBranch className="size-4" />
          Approval rules
        </TabsTrigger>
        <TabsTrigger value="delegations" className="gap-1.5">
          <UserCog className="size-4" />
          Delegations
        </TabsTrigger>
        <TabsTrigger value="simulate" className="gap-1.5">
          <PlayCircle className="size-4" />
          Simulate
        </TabsTrigger>
      </TabsList>
      <TabsContent value="rules">
        <RulesTab />
      </TabsContent>
      <TabsContent value="delegations">
        <DelegationsTab />
      </TabsContent>
      <TabsContent value="simulate">
        <SimulateTab />
      </TabsContent>
    </Tabs>
  )
}

/* ------------------------------- Rules tab ------------------------------- */

function RulesTab() {
  const { data, isLoading, mutate } = useSWR<{ rules: Rule[] }>("/api/admin/approval-authority/rules", fetcher)
  const { data: options } = useSWR<Options>("/api/admin/approval-authority/options", fetcher)
  const rules = data?.rules ?? []

  const [editing, setEditing] = useState<Rule | "new" | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null)

  const moduleLabel = (key: string) => options?.modules.find((m) => m.key === key)?.label ?? key

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Approval rules</h2>
          <p className="text-sm text-muted-foreground">
            Configure who must approve, based on amount, department, role, entity or module. Rules with higher
            priority win when several match.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          New rule
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : rules.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card p-10 text-center">
          <GitBranch className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No approval rules yet</p>
            <p className="text-sm text-muted-foreground">
              Create a rule to route requests through amount, role or multi-level approval chains.
            </p>
          </div>
          <Button variant="outline" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            New rule
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rules.map((rule) => (
            <div key={rule.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{rule.name}</p>
                    {!rule.active && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{rule.description || moduleLabel(rule.moduleKey)}</p>
                </div>
                <Badge variant="secondary" className="shrink-0 gap-1">
                  <Layers className="size-3" />
                  {rule.levels.length} level{rule.levels.length === 1 ? "" : "s"}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="outline">{moduleLabel(rule.moduleKey)}</Badge>
                {(rule.minAmount != null || rule.maxAmount != null) && (
                  <Badge variant="outline">
                    {rule.minAmount != null ? formatMoney(rule.minAmount) : "0"}
                    {" – "}
                    {rule.maxAmount != null ? formatMoney(rule.maxAmount) : "∞"}
                  </Badge>
                )}
                {rule.department && <Badge variant="outline">Dept: {rule.department}</Badge>}
                {rule.escalationHours != null && <Badge variant="outline">Escalate {rule.escalationHours}h</Badge>}
                <Badge variant="outline">Priority {rule.priority}</Badge>
              </div>

              <div className="mt-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(rule)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(rule)}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete {rule.name}</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && options && (
        <RuleEditorDialog
          rule={editing === "new" ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => {
            mutate()
            setEditing(null)
          }}
        />
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete approval rule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" will no longer route new requests. In-flight requests are unaffected.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return
                const res = await fetch(`/api/admin/approval-authority/rules/${deleteTarget.id}`, { method: "DELETE" })
                if (res.ok) {
                  toast.success("Rule deleted")
                  mutate()
                } else {
                  toast.error("Could not delete rule")
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RuleEditorDialog({
  rule,
  options,
  onClose,
  onSaved,
}: {
  rule: Rule | null
  options: Options
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(rule?.name ?? "")
  const [description, setDescription] = useState(rule?.description ?? "")
  const [moduleKey, setModuleKey] = useState(rule?.moduleKey ?? options.modules[0]?.key ?? "*")
  const [active, setActive] = useState(rule?.active ?? true)
  const [priority, setPriority] = useState(rule?.priority ?? 100)
  const [minAmount, setMinAmount] = useState(rule?.minAmount != null ? String(rule.minAmount) : "")
  const [maxAmount, setMaxAmount] = useState(rule?.maxAmount != null ? String(rule.maxAmount) : "")
  const [department, setDepartment] = useState(rule?.department ?? "")
  const [escalationHours, setEscalationHours] = useState(rule?.escalationHours != null ? String(rule.escalationHours) : "")
  const [levels, setLevels] = useState<RuleLevel[]>(rule?.levels?.length ? rule.levels : [{ ...EMPTY_LEVEL }])
  const [saving, setSaving] = useState(false)

  function updateLevel(index: number, patch: Partial<RuleLevel>) {
    setLevels((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }
  function addLevel() {
    setLevels((prev) => [...prev, { ...EMPTY_LEVEL, sequence: prev.length + 1 }])
  }
  function removeLevel(index: number) {
    setLevels((prev) => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, sequence: i + 1 })))
  }
  function addApprover(levelIndex: number, target: ApproverTarget) {
    setLevels((prev) => prev.map((l, i) => (i === levelIndex ? { ...l, approvers: [...l.approvers, target] } : l)))
  }
  function removeApprover(levelIndex: number, approverIndex: number) {
    setLevels((prev) =>
      prev.map((l, i) => (i === levelIndex ? { ...l, approvers: l.approvers.filter((_, j) => j !== approverIndex) } : l)),
    )
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Rule name is required")
      return
    }
    if (levels.some((l) => l.approvers.length === 0)) {
      toast.error("Every level needs at least one approver")
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        moduleKey,
        active,
        priority: Number(priority) || 0,
        minAmount: minAmount === "" ? null : Number(minAmount),
        maxAmount: maxAmount === "" ? null : Number(maxAmount),
        department: department.trim() || null,
        escalationHours: escalationHours === "" ? null : Number(escalationHours),
        levels: levels.map((l, i) => ({ ...l, sequence: i + 1 })),
      }
      const res = await fetch(
        rule ? `/api/admin/approval-authority/rules/${rule.id}` : "/api/admin/approval-authority/rules",
        {
          method: rule ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not save rule")
        return
      }
      toast.success(rule ? "Rule updated" : "Rule created")
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit approval rule" : "New approval rule"}</DialogTitle>
          <DialogDescription>
            Match requests by criteria, then define one or more approval levels. Levels run in order; within a level,
            approvers run sequentially or in parallel.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-name">Rule name</Label>
              <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. High-value expenses" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-module">Module</Label>
              <Select value={moduleKey} onValueChange={setModuleKey}>
                <SelectTrigger id="rule-module">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.modules.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-desc">Description</Label>
            <Textarea id="rule-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional" />
          </div>

          <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Match criteria</legend>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-min">Min amount</Label>
              <Input id="rule-min" type="number" inputMode="decimal" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="Any" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-max">Max amount</Label>
              <Input id="rule-max" type="number" inputMode="decimal" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder="Any" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-dept">Department</Label>
              {options.departments.length > 0 ? (
                <Select value={department || "__any"} onValueChange={(v) => setDepartment(v === "__any" ? "" : v)}>
                  <SelectTrigger id="rule-dept">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any">Any department</SelectItem>
                    {options.departments.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input id="rule-dept" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Any" />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-priority">Priority</Label>
              <Input id="rule-priority" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </div>
          </fieldset>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Approval levels</h3>
              <Button size="sm" variant="outline" onClick={addLevel}>
                <Plus className="size-4" />
                Add level
              </Button>
            </div>

            {levels.map((level, li) => (
              <div key={li} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Badge variant="secondary">Level {li + 1}</Badge>
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`mode-${li}`} className="text-xs text-muted-foreground">
                        {level.mode === "parallel" ? "Parallel" : "Sequential"}
                      </Label>
                      <Switch
                        id={`mode-${li}`}
                        checked={level.mode === "parallel"}
                        onCheckedChange={(c) => updateLevel(li, { mode: c ? "parallel" : "sequential" })}
                      />
                    </div>
                    {level.mode === "parallel" && (
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor={`min-${li}`} className="text-xs text-muted-foreground">
                          Min approvals
                        </Label>
                        <Input
                          id={`min-${li}`}
                          type="number"
                          min={1}
                          className="h-8 w-16"
                          value={level.minApprovals}
                          onChange={(e) => updateLevel(li, { minApprovals: Math.max(1, Number(e.target.value)) })}
                        />
                      </div>
                    )}
                    {levels.length > 1 && (
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => removeLevel(li)}>
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remove level {li + 1}</span>
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {level.approvers.length === 0 && <span className="text-xs text-muted-foreground">No approvers yet</span>}
                  {level.approvers.map((a, ai) => (
                    <Badge key={ai} variant="outline" className="gap-1 pr-1">
                      {describeApprover(a, options)}
                      <button
                        type="button"
                        className="ml-1 rounded-sm text-muted-foreground hover:text-destructive"
                        onClick={() => removeApprover(li, ai)}
                        aria-label="Remove approver"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>

                <ApproverPicker options={options} onAdd={(t) => addApprover(li, t)} />
              </div>
            ))}
          </div>

          <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Escalation & status</legend>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-esc">Escalate after (hours)</Label>
              <Input id="rule-esc" type="number" value={escalationHours} onChange={(e) => setEscalationHours(e.target.value)} placeholder="Never" />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="rule-active">Active</Label>
              <Switch id="rule-active" checked={active} onCheckedChange={setActive} />
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApproverPicker({ options, onAdd }: { options: Options; onAdd: (t: ApproverTarget) => void }) {
  const [kind, setKind] = useState<ApproverTarget["kind"]>("user")
  const [value, setValue] = useState("")

  useEffect(() => {
    setValue("")
  }, [kind])

  function add() {
    if (kind === "user" && value) onAdd({ kind, userId: Number(value) })
    else if (kind === "role" && value) onAdd({ kind, roleId: Number(value) })
    else if (kind === "entity" && value) onAdd({ kind, entityId: Number(value) })
    else if (kind === "department" && value) onAdd({ kind, department: value })
    else if (kind === "dynamic" && value) onAdd({ kind, dynamic: value })
    else {
      toast.error("Pick an approver")
      return
    }
    setValue("")
  }

  const choices: { v: string; label: string }[] =
    kind === "user"
      ? options.users.map((u) => ({ v: String(u.id), label: u.name || u.email }))
      : kind === "role"
        ? options.roles.map((r) => ({ v: String(r.id), label: r.name }))
        : kind === "entity"
          ? options.entities.map((e) => ({ v: String(e.id), label: e.name }))
          : kind === "department"
            ? options.departments.map((d) => ({ v: d, label: d }))
            : options.dynamicApprovers.map((d) => ({ v: d.value, label: d.label }))

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Approver type</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as ApproverTarget["kind"])}>
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">Specific user</SelectItem>
            <SelectItem value="role">Role</SelectItem>
            <SelectItem value="department">Department</SelectItem>
            <SelectItem value="entity">Legal entity</SelectItem>
            <SelectItem value="dynamic">Dynamic</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Approver</Label>
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="h-8 min-w-40">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {choices.length === 0 ? (
              <SelectItem value="__none" disabled>
                None available
              </SelectItem>
            ) : (
              choices.map((c) => (
                <SelectItem key={c.v} value={c.v}>
                  {c.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="secondary" onClick={add}>
        <Plus className="size-4" />
        Add
      </Button>
    </div>
  )
}

/* ---------------------------- Delegations tab ---------------------------- */

type Delegation = {
  id: number
  fromUserId: number
  fromName: string | null
  toUserId: number
  toName: string | null
  reason: string | null
  active: boolean
  startsAt: string | null
  endsAt: string | null
}

function DelegationsTab() {
  const { data, isLoading, mutate } = useSWR<{ delegations: Delegation[] }>(
    "/api/admin/approval-authority/delegations",
    fetcher,
  )
  const { data: options } = useSWR<Options>("/api/admin/approval-authority/options", fetcher)
  const delegations = data?.delegations ?? []
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Delegations</h2>
          <p className="text-sm text-muted-foreground">
            Temporarily reassign one approver&apos;s pending decisions to another user (e.g. during leave).
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!options}>
          <Plus className="size-4" />
          New delegation
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : delegations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card p-10 text-center">
          <UserCog className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No delegations configured.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {delegations.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{d.fromName ?? `User #${d.fromUserId}`}</span>
                <ArrowRight className="size-4 text-muted-foreground" />
                <span className="font-medium">{d.toName ?? `User #${d.toUserId}`}</span>
                {d.reason && <span className="text-muted-foreground">— {d.reason}</span>}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{d.active ? "Active" : "Paused"}</span>
                  <Switch
                    checked={d.active}
                    onCheckedChange={async (c) => {
                      await fetch(`/api/admin/approval-authority/delegations/${d.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ active: c }),
                      })
                      mutate()
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={async () => {
                    await fetch(`/api/admin/approval-authority/delegations/${d.id}`, { method: "DELETE" })
                    mutate()
                  }}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete delegation</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && options && (
        <NewDelegationDialog
          options={options}
          onClose={() => setOpen(false)}
          onSaved={() => {
            mutate()
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

function NewDelegationDialog({ options, onClose, onSaved }: { options: Options; onClose: () => void; onSaved: () => void }) {
  const [fromUserId, setFromUserId] = useState("")
  const [toUserId, setToUserId] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!fromUserId || !toUserId) {
      toast.error("Pick both users")
      return
    }
    if (fromUserId === toUserId) {
      toast.error("Cannot delegate to the same user")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/approval-authority/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromUserId: Number(fromUserId), toUserId: Number(toUserId), reason: reason.trim() || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not create delegation")
        return
      }
      toast.success("Delegation created")
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New delegation</DialogTitle>
          <DialogDescription>Route pending approvals from one user to another.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>Delegate from</Label>
            <Select value={fromUserId} onValueChange={setFromUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select user" />
              </SelectTrigger>
              <SelectContent>
                {options.users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name || u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Delegate to</Label>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select user" />
              </SelectTrigger>
              <SelectContent>
                {options.users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name || u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="del-reason">Reason</Label>
            <Input id="del-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Annual leave (optional)" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ----------------------------- Simulate tab ------------------------------ */

type SimResult = {
  matchedRule: { id: number; name: string } | null
  steps: { level: number; mode: string; minApprovals: number; approvers: string[] }[]
  reason?: string
}

function SimulateTab() {
  const { data: options } = useSWR<Options>("/api/admin/approval-authority/options", fetcher)
  const [moduleKey, setModuleKey] = useState("*")
  const [amount, setAmount] = useState("")
  const [department, setDepartment] = useState("")
  const [result, setResult] = useState<SimResult | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (options && moduleKey === "*" && options.modules[0]) setModuleKey(options.modules[0].key)
  }, [options, moduleKey])

  async function run() {
    setRunning(true)
    try {
      const res = await fetch("/api/admin/approval-authority/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleKey,
          amount: amount === "" ? null : Number(amount),
          department: department.trim() || null,
        }),
      })
      const body = await res.json().catch(() => null)
      setResult(body)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Simulate a chain</h2>
        <p className="text-sm text-muted-foreground">
          Preview which rule matches and the resulting approval chain for a hypothetical request.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-module">Module</Label>
          <Select value={moduleKey} onValueChange={setModuleKey}>
            <SelectTrigger id="sim-module" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options?.modules.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-amount">Amount</Label>
          <Input id="sim-amount" type="number" className="w-40" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-dept">Department</Label>
          <Input id="sim-dept" className="w-40" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Any" />
        </div>
        <Button onClick={run} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
          Simulate
        </Button>
      </div>

      {result && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          {result.matchedRule ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Matched rule:</span>
                <Badge>{result.matchedRule.name}</Badge>
              </div>
              <ol className="flex flex-col gap-2">
                {result.steps.map((s) => (
                  <li key={s.level} className="flex flex-col gap-1 rounded-md border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Badge variant="secondary">Level {s.level}</Badge>
                      <span className="text-muted-foreground">
                        {s.mode === "parallel" ? `Parallel · ${s.minApprovals} of ${s.approvers.length} required` : "Sequential"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.approvers.map((a, i) => (
                        <Badge key={i} variant="outline">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {result.reason || "No matching rule — this request would be auto-approved or require manual routing."}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------- helpers -------------------------------- */

function describeApprover(a: ApproverTarget, options: Options): string {
  switch (a.kind) {
    case "user":
      return options.users.find((u) => u.id === a.userId)?.name ?? `User #${a.userId}`
    case "role":
      return `Role: ${options.roles.find((r) => r.id === a.roleId)?.name ?? a.roleId}`
    case "department":
      return `Dept: ${a.department}`
    case "entity":
      return `Entity: ${options.entities.find((e) => e.id === a.entityId)?.name ?? a.entityId}`
    case "dynamic":
      return options.dynamicApprovers.find((d) => d.value === a.dynamic)?.label ?? String(a.dynamic)
    default:
      return "Unknown"
  }
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)
}
