"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Loader2, Plus, GitBranch, Trash2, Layers, UserCog, PlayCircle, ArrowRight, AlertTriangle } from "lucide-react"
import { toast } from "sonner"

// -----------------------------------------------------------------------------
// Types mirror the backend contract exactly (lib/approval-authority-core.ts +
// lib/approval-authority.ts). A rule matches requests by conditions, then runs
// one or more levels in sequence; within a level, approvers combine per `mode`.
// -----------------------------------------------------------------------------

type ApproverKind = "user" | "role" | "department" | "dynamic"
type ApproverTarget = { kind: ApproverKind; value: string }
type LevelMode = "all" | "any" | "quorum"

type RuleLevel = {
  levelNo: number
  name?: string | null
  mode: LevelMode
  quorum?: number | null
  approvers: ApproverTarget[]
  escalateAfterHours?: number | null
  escalateTo?: ApproverTarget | null
}

type RuleConditions = {
  entityId?: number | null
  department?: string | null
  role?: string | null
  minAmount?: number | null
  maxAmount?: number | null
}

type Rule = {
  id: number
  name: string
  moduleKey: string
  active: boolean
  priority: number
  conditions: RuleConditions
  levels: RuleLevel[]
  createdAt: string
  updatedAt: string
}

type Options = {
  modules: { key: string; label: string }[]
  users: { id: number; name: string; email: string }[]
  roles: { id: number; name: string }[]
  entities: { id: number; name: string }[]
  departments: string[]
  dynamicApprovers: { value: string; label: string }[]
}

const ANY = "__any"

function newLevel(levelNo: number): RuleLevel {
  return { levelNo, mode: "all", quorum: 2, approvers: [], escalateAfterHours: null, escalateTo: null }
}

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
            Configure who must approve, based on amount, department, role, entity or module. Rules with higher priority
            win when several match.
          </p>
        </div>
        <Button onClick={() => setEditing("new")} disabled={!options}>
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
          <Button variant="outline" onClick={() => setEditing("new")} disabled={!options}>
            <Plus className="size-4" />
            New rule
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              options={options}
              moduleLabel={moduleLabel}
              onEdit={() => setEditing(rule)}
              onDelete={() => setDeleteTarget(rule)}
            />
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
              {deleteTarget
                ? `"${deleteTarget.name}" will no longer route new requests. In-flight requests are unaffected.`
                : ""}
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

function RuleCard({
  rule,
  options,
  moduleLabel,
  onEdit,
  onDelete,
}: {
  rule: Rule
  options?: Options
  moduleLabel: (key: string) => string
  onEdit: () => void
  onDelete: () => void
}) {
  const c = rule.conditions
  const entityName = c.entityId != null ? options?.entities.find((e) => e.id === c.entityId)?.name : null
  const hasEscalation = rule.levels.some((l) => (l.escalateAfterHours ?? 0) > 0)

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{rule.name}</p>
            {!rule.active && <Badge variant="outline">Inactive</Badge>}
          </div>
          <p className="line-clamp-1 text-sm text-muted-foreground">{moduleLabel(rule.moduleKey)}</p>
        </div>
        <Badge variant="secondary" className="shrink-0 gap-1">
          <Layers className="size-3" />
          {rule.levels.length} level{rule.levels.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge variant="outline">{moduleLabel(rule.moduleKey)}</Badge>
        {(c.minAmount != null || c.maxAmount != null) && (
          <Badge variant="outline">
            {c.minAmount != null ? formatMoney(c.minAmount) : "0"}
            {" – "}
            {c.maxAmount != null ? formatMoney(c.maxAmount) : "∞"}
          </Badge>
        )}
        {c.department && <Badge variant="outline">Dept: {c.department}</Badge>}
        {c.role && <Badge variant="outline">Role: {c.role}</Badge>}
        {entityName && <Badge variant="outline">Entity: {entityName}</Badge>}
        {hasEscalation && <Badge variant="outline">Escalation</Badge>}
        <Badge variant="outline">Priority {rule.priority}</Badge>
      </div>

      <div className="flex flex-col gap-1">
        {rule.levels.map((l) => (
          <div key={l.levelNo} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="shrink-0">
              L{l.levelNo}
            </Badge>
            <span className="shrink-0 font-medium">{describeMode(l)}</span>
            <span className="truncate">
              {l.approvers.length === 0
                ? "no approvers"
                : l.approvers.map((a) => describeApprover(a, options)).join(", ")}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-auto flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="size-4" />
          <span className="sr-only">Delete {rule.name}</span>
        </Button>
      </div>
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
  const [moduleKey, setModuleKey] = useState(rule?.moduleKey ?? options.modules[0]?.key ?? "*")
  const [active, setActive] = useState(rule?.active ?? true)
  const [priority, setPriority] = useState(rule?.priority ?? 100)
  const [minAmount, setMinAmount] = useState(rule?.conditions.minAmount != null ? String(rule.conditions.minAmount) : "")
  const [maxAmount, setMaxAmount] = useState(rule?.conditions.maxAmount != null ? String(rule.conditions.maxAmount) : "")
  const [department, setDepartment] = useState(rule?.conditions.department ?? "")
  const [role, setRole] = useState(rule?.conditions.role ?? "")
  const [entityId, setEntityId] = useState(rule?.conditions.entityId != null ? String(rule.conditions.entityId) : "")
  const [levels, setLevels] = useState<RuleLevel[]>(
    rule?.levels?.length ? rule.levels.map((l) => ({ ...l })) : [newLevel(1)],
  )
  const [saving, setSaving] = useState(false)

  function updateLevel(index: number, patch: Partial<RuleLevel>) {
    setLevels((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }
  function addLevel() {
    setLevels((prev) => [...prev, newLevel(prev.length + 1)])
  }
  function removeLevel(index: number) {
    setLevels((prev) => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, levelNo: i + 1 })))
  }
  function addApprover(levelIndex: number, target: ApproverTarget) {
    setLevels((prev) =>
      prev.map((l, i) =>
        i === levelIndex
          ? l.approvers.some((a) => a.kind === target.kind && a.value === target.value)
            ? l
            : { ...l, approvers: [...l.approvers, target] }
          : l,
      ),
    )
  }
  function removeApprover(levelIndex: number, approverIndex: number) {
    setLevels((prev) =>
      prev.map((l, i) =>
        i === levelIndex ? { ...l, approvers: l.approvers.filter((_, j) => j !== approverIndex) } : l,
      ),
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
    const min = minAmount === "" ? null : Number(minAmount)
    const max = maxAmount === "" ? null : Number(maxAmount)
    if (min != null && max != null && min > max) {
      toast.error("Min amount cannot exceed max amount")
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        moduleKey,
        active,
        priority: Number(priority) || 0,
        conditions: {
          entityId: entityId === "" ? null : Number(entityId),
          department: department.trim() || null,
          role: role.trim() || null,
          minAmount: min,
          maxAmount: max,
        },
        levels: levels.map((l, i) => ({
          levelNo: i + 1,
          name: l.name?.trim() || null,
          mode: l.mode,
          quorum: l.mode === "quorum" ? Math.max(1, l.quorum ?? 1) : null,
          approvers: l.approvers,
          escalateAfterHours: l.escalateAfterHours && l.escalateAfterHours > 0 ? l.escalateAfterHours : null,
          escalateTo: l.escalateAfterHours && l.escalateAfterHours > 0 ? l.escalateTo ?? null : null,
        })),
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
            Match requests by criteria, then define one or more approval levels. Levels run sequentially; within a
            level, approvers combine by the chosen mode (all / any one / quorum).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-name">Rule name</Label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="e.g. High-value expenses"
              />
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

          <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Match criteria</legend>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-min">Min amount</Label>
              <Input
                id="rule-min"
                type="number"
                inputMode="decimal"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Any"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-max">Max amount</Label>
              <Input
                id="rule-max"
                type="number"
                inputMode="decimal"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="Any"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-dept">Department</Label>
              {options.departments.length > 0 ? (
                <Select value={department || ANY} onValueChange={(v) => setDepartment(v === ANY ? "" : v)}>
                  <SelectTrigger id="rule-dept">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any department</SelectItem>
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
              <Label htmlFor="rule-role">Requester role</Label>
              {options.roles.length > 0 ? (
                <Select value={role || ANY} onValueChange={(v) => setRole(v === ANY ? "" : v)}>
                  <SelectTrigger id="rule-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any role</SelectItem>
                    {options.roles.map((r) => (
                      <SelectItem key={r.id} value={r.name}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input id="rule-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Any" />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-entity">Legal entity</Label>
              <Select value={entityId || ANY} onValueChange={(v) => setEntityId(v === ANY ? "" : v)}>
                <SelectTrigger id="rule-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any entity</SelectItem>
                  {options.entities.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-priority">Priority</Label>
              <Input
                id="rule-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </fieldset>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Approval levels</h3>
                <p className="text-xs text-muted-foreground">Level 1 runs first; each level unlocks the next.</p>
              </div>
              <Button size="sm" variant="outline" onClick={addLevel}>
                <Plus className="size-4" />
                Add level
              </Button>
            </div>

            {levels.map((level, li) => (
              <LevelEditor
                key={li}
                index={li}
                level={level}
                options={options}
                canRemove={levels.length > 1}
                onChange={(patch) => updateLevel(li, patch)}
                onRemove={() => removeLevel(li)}
                onAddApprover={(t) => addApprover(li, t)}
                onRemoveApprover={(ai) => removeApprover(li, ai)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="rule-active">Active</Label>
            <Switch id="rule-active" checked={active} onCheckedChange={setActive} />
          </div>
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

function LevelEditor({
  index,
  level,
  options,
  canRemove,
  onChange,
  onRemove,
  onAddApprover,
  onRemoveApprover,
}: {
  index: number
  level: RuleLevel
  options: Options
  canRemove: boolean
  onChange: (patch: Partial<RuleLevel>) => void
  onRemove: () => void
  onAddApprover: (t: ApproverTarget) => void
  onRemoveApprover: (approverIndex: number) => void
}) {
  const escalationOn = (level.escalateAfterHours ?? 0) > 0

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Level {index + 1}</Badge>
          <Input
            aria-label={`Level ${index + 1} name`}
            value={level.name ?? ""}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Level name (optional)"
            className="h-8 w-48"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Mode</Label>
            <Select value={level.mode} onValueChange={(v) => onChange({ mode: v as LevelMode })}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All must approve</SelectItem>
                <SelectItem value="any">Any one approves</SelectItem>
                <SelectItem value="quorum">Quorum</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {level.mode === "quorum" && (
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Required</Label>
              <Input
                type="number"
                min={1}
                className="h-8 w-16"
                value={level.quorum ?? 1}
                onChange={(e) => onChange({ quorum: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          )}
          {canRemove && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
              <span className="sr-only">Remove level {index + 1}</span>
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
              onClick={() => onRemoveApprover(ai)}
              aria-label="Remove approver"
            >
              <Trash2 className="size-3" />
            </button>
          </Badge>
        ))}
      </div>

      <ApproverPicker options={options} onAdd={onAddApprover} />

      <div className="flex flex-wrap items-end gap-3 border-t pt-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Escalate after (hours)</Label>
          <Input
            type="number"
            min={0}
            className="h-8 w-28"
            value={level.escalateAfterHours ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : Math.max(0, Number(e.target.value))
              onChange({ escalateAfterHours: v })
            }}
            placeholder="Never"
          />
        </div>
        {escalationOn && (
          <div className="flex flex-1 flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Escalate to</Label>
            <SingleApproverPicker
              options={options}
              value={level.escalateTo ?? null}
              onChange={(t) => onChange({ escalateTo: t })}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------- Approver pickers ---------------------------- */

function approverChoices(kind: ApproverKind, options: Options): { v: string; label: string }[] {
  switch (kind) {
    case "user":
      return options.users.map((u) => ({ v: String(u.id), label: u.name || u.email }))
    case "role":
      return options.roles.map((r) => ({ v: String(r.id), label: r.name }))
    case "department":
      return options.departments.map((d) => ({ v: d, label: d }))
    case "dynamic":
      return options.dynamicApprovers.map((d) => ({ v: d.value, label: d.label }))
  }
}

function ApproverPicker({ options, onAdd }: { options: Options; onAdd: (t: ApproverTarget) => void }) {
  const [kind, setKind] = useState<ApproverKind>("user")
  const [value, setValue] = useState("")

  useEffect(() => {
    setValue("")
  }, [kind])

  const choices = approverChoices(kind, options)

  function add() {
    if (!value) {
      toast.error("Pick an approver")
      return
    }
    onAdd({ kind, value })
    setValue("")
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Approver type</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as ApproverKind)}>
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">Specific user</SelectItem>
            <SelectItem value="role">Role</SelectItem>
            <SelectItem value="department">Department</SelectItem>
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

function SingleApproverPicker({
  options,
  value,
  onChange,
}: {
  options: Options
  value: ApproverTarget | null
  onChange: (t: ApproverTarget | null) => void
}) {
  const kind = value?.kind ?? "user"
  const choices = approverChoices(kind, options)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={kind} onValueChange={(v) => onChange({ kind: v as ApproverKind, value: "" })}>
        <SelectTrigger className="h-8 w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="user">Specific user</SelectItem>
          <SelectItem value="role">Role</SelectItem>
          <SelectItem value="department">Department</SelectItem>
          <SelectItem value="dynamic">Dynamic</SelectItem>
        </SelectContent>
      </Select>
      <Select value={value?.value || ""} onValueChange={(v) => onChange({ kind, value: v })}>
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

function NewDelegationDialog({
  options,
  onClose,
  onSaved,
}: {
  options: Options
  onClose: () => void
  onSaved: () => void
}) {
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
            <Input
              id="del-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Annual leave (optional)"
            />
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

type SimStep = {
  level: number
  levelName: string | null
  mode: LevelMode
  quorum: number | null
  approvers: ApproverTarget[]
}
type SimResult = {
  matchedRule: { id: number; name: string } | null
  steps: SimStep[]
  reason?: string
}

function SimulateTab() {
  const { data: options } = useSWR<Options>("/api/admin/approval-authority/options", fetcher)
  const [moduleKey, setModuleKey] = useState("*")
  const [amount, setAmount] = useState("")
  const [department, setDepartment] = useState("")
  const [role, setRole] = useState("")
  const [entityId, setEntityId] = useState("")
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
          role: role.trim() || null,
          entityId: entityId === "" ? null : Number(entityId),
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
          <Input
            id="sim-amount"
            type="number"
            className="w-40"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-dept">Department</Label>
          {options && options.departments.length > 0 ? (
            <Select value={department || ANY} onValueChange={(v) => setDepartment(v === ANY ? "" : v)}>
              <SelectTrigger id="sim-dept" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {options.departments.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input id="sim-dept" className="w-40" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Any" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-role">Role</Label>
          {options && options.roles.length > 0 ? (
            <Select value={role || ANY} onValueChange={(v) => setRole(v === ANY ? "" : v)}>
              <SelectTrigger id="sim-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any</SelectItem>
                {options.roles.map((r) => (
                  <SelectItem key={r.id} value={r.name}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input id="sim-role" className="w-40" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Any" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-entity">Entity</Label>
          <Select value={entityId || ANY} onValueChange={(v) => setEntityId(v === ANY ? "" : v)}>
            <SelectTrigger id="sim-entity" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              {options?.entities.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                      {s.levelName && <span className="text-muted-foreground">{s.levelName}</span>}
                      <span className="text-muted-foreground">
                        {describeMode({ mode: s.mode, quorum: s.quorum, approvers: s.approvers } as RuleLevel)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.approvers.map((a, i) => (
                        <Badge key={i} variant="outline">
                          {describeApprover(a, options)}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="size-4" />
              {result.reason || "No matching rule — this request would be auto-approved or require manual routing."}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------- helpers -------------------------------- */

function describeMode(level: Pick<RuleLevel, "mode" | "quorum" | "approvers">): string {
  if (level.mode === "any") return "Any one approves"
  if (level.mode === "quorum") return `${Math.max(1, level.quorum ?? 1)} of ${level.approvers.length} required`
  return "All must approve"
}

function describeApprover(a: ApproverTarget, options?: Options): string {
  switch (a.kind) {
    case "user":
      return options?.users.find((u) => String(u.id) === a.value)?.name ?? `User #${a.value}`
    case "role":
      return `Role: ${options?.roles.find((r) => String(r.id) === a.value)?.name ?? a.value}`
    case "department":
      return `Dept: ${a.value}`
    case "dynamic":
      return options?.dynamicApprovers.find((d) => d.value === a.value)?.label ?? a.value
    default:
      return "Unknown"
  }
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)
}
