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
import { Loader2, Plus, ScanFace, Trash2, ShieldAlert, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import {
  ABAC_ACTIONS,
  ABAC_ATTRIBUTE_CATALOG,
  ABAC_OPERATORS,
  type AbacCondition,
  type AbacOperator,
  type AbacPolicy,
  type AbacTarget,
} from "@/lib/abac-model"
import { PERMISSION_GROUPS } from "@/lib/permission-model"

const OPERATOR_LABEL: Record<AbacOperator, string> = {
  eq: "equals",
  ne: "not equals",
  in: "in set",
  not_in: "not in set",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
  contains: "contains",
  not_contains: "does not contain",
}

const TARGET_LABEL: Record<AbacTarget, string> = {
  subject: "User",
  resource: "Record",
  environment: "Environment",
}

const ALGORITHM_LABEL: Record<string, string> = {
  "deny-overrides": "Deny overrides (safest)",
  "permit-overrides": "Permit overrides",
  priority: "Highest priority wins",
  "first-applicable": "First applicable",
}

type PolicyList = { policies: AbacPolicy[] }
type Settings = { algorithm: string; defaultDecision: "permit" | "deny" }

const emptyCondition = (): AbacCondition => ({
  target: "resource",
  attribute: "department",
  operator: "eq",
  operand: { kind: "attribute", target: "subject", attribute: "department" },
})

export function AbacManager() {
  const { data, isLoading, mutate } = useSWR<PolicyList>("/api/admin/abac/policies", fetcher)
  const { data: settingsData, mutate: mutateSettings } = useSWR<{ settings: Settings }>(
    "/api/admin/abac/settings",
    fetcher,
  )
  const policies = data?.policies ?? []
  const settings = settingsData?.settings

  const [editing, setEditing] = useState<AbacPolicy | "new" | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AbacPolicy | null>(null)

  async function saveSettings(next: Partial<Settings>) {
    const res = await fetch("/api/admin/abac/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    })
    if (res.ok) {
      mutateSettings()
      toast.success("Precedence updated")
    } else {
      toast.error("Could not update precedence")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Attribute policies</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Rules evaluated on top of roles. They compare attributes of the user, the record and the environment
            (department, branch, entity, amount, data classification, manager hierarchy and more) to further restrict
            access that a role would otherwise allow.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          New policy
        </Button>
      </div>

      <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Conflict resolution</Label>
          <Select value={settings?.algorithm ?? "deny-overrides"} onValueChange={(v) => saveSettings({ algorithm: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ALGORITHM_LABEL).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How overlapping policies are combined when they disagree.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label>When no policy matches</Label>
          <Select
            value={settings?.defaultDecision ?? "permit"}
            onValueChange={(v) => saveSettings({ defaultDecision: v as "permit" | "deny" })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="permit">Allow (roles decide)</SelectItem>
              <SelectItem value="deny">Deny (default-deny posture)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Default-deny blocks any access no attribute policy explicitly permits.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : policies.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card p-10 text-center">
          <ScanFace className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No attribute policies yet</p>
            <p className="text-sm text-muted-foreground">
              Create a policy to restrict access by department, branch, amount thresholds, hierarchy and more.
            </p>
          </div>
          <Button variant="outline" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            New policy
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {policies.map((p) => (
            <div key={p.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  {p.effect === "deny" ? (
                    <ShieldAlert className="mt-0.5 size-5 text-destructive" />
                  ) : (
                    <ShieldCheck className="mt-0.5 size-5 text-emerald-600" />
                  )}
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {p.name}
                      {!p.enabled && <Badge variant="outline">Disabled</Badge>}
                    </p>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{p.description || "No description"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={p.effect === "deny" ? "destructive" : "secondary"}>{p.effect}</Badge>
                  <Badge variant="outline">priority {p.priority}</Badge>
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Delete {p.name}</span>
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="rounded bg-muted px-2 py-0.5">
                  modules: {p.modules.join(", ")}
                </span>
                <span className="rounded bg-muted px-2 py-0.5">actions: {p.actions.join(", ")}</span>
                <span className="rounded bg-muted px-2 py-0.5">
                  {p.conditions.length} condition{p.conditions.length === 1 ? "" : "s"} ({p.combine ?? "all"})
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <PolicyEditorDialog
        policy={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          mutate()
          setEditing(null)
        }}
      />

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete policy?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" will stop being evaluated. This cannot be undone.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return
                const res = await fetch(`/api/admin/abac/policies/${deleteTarget.id}`, { method: "DELETE" })
                if (res.ok) {
                  toast.success("Policy deleted")
                  mutate()
                } else {
                  toast.error("Could not delete policy")
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

function PolicyEditorDialog({
  policy,
  onClose,
  onSaved,
}: {
  policy: AbacPolicy | "new" | null
  onClose: () => void
  onSaved: () => void
}) {
  const open = policy !== null
  const isNew = policy === "new"

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [effect, setEffect] = useState<"permit" | "deny">("deny")
  const [priority, setPriority] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const [combine, setCombine] = useState<"all" | "any">("all")
  const [modules, setModules] = useState<string>("*")
  const [actions, setActions] = useState<string[]>(["*"])
  const [conditions, setConditions] = useState<AbacCondition[]>([emptyCondition()])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (policy && policy !== "new") {
      setName(policy.name)
      setDescription(policy.description ?? "")
      setEffect(policy.effect)
      setPriority(policy.priority)
      setEnabled(policy.enabled)
      setCombine(policy.combine ?? "all")
      setModules(policy.modules.join(", "))
      setActions(policy.actions.length ? policy.actions : ["*"])
      setConditions(policy.conditions.length ? policy.conditions : [emptyCondition()])
    } else if (policy === "new") {
      setName("")
      setDescription("")
      setEffect("deny")
      setPriority(0)
      setEnabled(true)
      setCombine("all")
      setModules("*")
      setActions(["*"])
      setConditions([emptyCondition()])
    }
  }, [policy])

  const moduleOptions = useMemo(
    () =>
      PERMISSION_GROUPS.map((g) => ({
        group: g.label,
        modules: g.modules.map((m) => ({ key: m.key, label: m.label })),
      })),
    [],
  )

  async function save() {
    if (!name.trim()) {
      toast.error("Policy name is required")
      return
    }
    const body = {
      name,
      description,
      effect,
      priority,
      enabled,
      combine,
      modules: modules
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      actions,
      conditions,
    }
    setSaving(true)
    try {
      const url = isNew ? "/api/admin/abac/policies" : `/api/admin/abac/policies/${(policy as AbacPolicy).id}`
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const resBody = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(resBody.error || "Could not save policy")
        return
      }
      toast.success(isNew ? "Policy created" : "Policy saved")
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  function toggleAction(a: string) {
    setActions((prev) => {
      if (a === "*") return ["*"]
      const without = prev.filter((x) => x !== "*")
      return without.includes(a) ? without.filter((x) => x !== a) : [...without, a]
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? "New attribute policy" : "Edit attribute policy"}</DialogTitle>
          <DialogDescription>
            A policy applies when its module + action scope matches and all/any of its conditions hold.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="abac-name">Name</Label>
              <Input id="abac-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="abac-effect">Effect</Label>
              <Select value={effect} onValueChange={(v) => setEffect(v as "permit" | "deny")}>
                <SelectTrigger id="abac-effect">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deny">Deny</SelectItem>
                  <SelectItem value="permit">Permit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="abac-desc">Description</Label>
            <Textarea
              id="abac-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="abac-priority">Priority</Label>
              <Input
                id="abac-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="abac-combine">Match</Label>
              <Select value={combine} onValueChange={(v) => setCombine(v as "all" | "any")}>
                <SelectTrigger id="abac-combine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All conditions (AND)</SelectItem>
                  <SelectItem value="any">Any condition (OR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col justify-end gap-2">
              <Label htmlFor="abac-enabled">Enabled</Label>
              <div className="flex h-9 items-center">
                <Switch id="abac-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="abac-modules">Modules</Label>
            <Input
              id="abac-modules"
              value={modules}
              onChange={(e) => setModules(e.target.value)}
              placeholder="* or finance.expenses, finance.* (comma separated)"
            />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Browse module keys</summary>
              <div className="mt-2 flex flex-col gap-2">
                {moduleOptions.map((g) => (
                  <div key={g.group}>
                    <p className="font-medium text-foreground">{g.group}</p>
                    <div className="flex flex-wrap gap-1">
                      {g.modules.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          className="rounded border px-1.5 py-0.5 hover:bg-accent"
                          onClick={() => {
                            const cur = modules
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean)
                              .filter((x) => x !== "*")
                            if (!cur.includes(m.key)) setModules([...cur, m.key].join(", "))
                          }}
                          title={m.key}
                        >
                          {m.key}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Actions</Label>
            <div className="flex flex-wrap gap-1.5">
              {["*", ...ABAC_ACTIONS].map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggleAction(a)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    actions.includes(a) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label>Conditions</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConditions((c) => [...c, emptyCondition()])}
              >
                <Plus className="size-4" />
                Add condition
              </Button>
            </div>
            {conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                cond={cond}
                onChange={(next) => setConditions((cs) => cs.map((c, idx) => (idx === i ? next : c)))}
                onRemove={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}
                canRemove={conditions.length > 1}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {isNew ? "Create policy" : "Save policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConditionRow({
  cond,
  onChange,
  onRemove,
  canRemove,
}: {
  cond: AbacCondition
  onChange: (next: AbacCondition) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const targets: AbacTarget[] = ["subject", "resource", "environment"]
  const literalValue =
    cond.operand.kind === "literal"
      ? Array.isArray(cond.operand.value)
        ? cond.operand.value.join(", ")
        : String(cond.operand.value)
      : ""

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Attribute of</span>
          <Select value={cond.target} onValueChange={(v) => onChange({ ...cond, target: v as AbacTarget })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t} value={t}>
                  {TARGET_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Attribute</span>
          <Select value={cond.attribute} onValueChange={(v) => onChange({ ...cond, attribute: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ABAC_ATTRIBUTE_CATALOG.map((a) => (
                <SelectItem key={a.key} value={a.key}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Operator</span>
          <Select value={cond.operator} onValueChange={(v) => onChange({ ...cond, operator: v as AbacOperator })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ABAC_OPERATORS.map((op) => (
                <SelectItem key={op} value={op}>
                  {OPERATOR_LABEL[op]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-end">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Compare to</span>
          <Select
            value={cond.operand.kind}
            onValueChange={(v) =>
              onChange({
                ...cond,
                operand:
                  v === "attribute"
                    ? { kind: "attribute", target: "subject", attribute: cond.attribute }
                    : { kind: "literal", value: "" },
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="attribute">Another attribute</SelectItem>
              <SelectItem value="literal">A fixed value</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {cond.operand.kind === "attribute" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              value={cond.operand.target}
              onValueChange={(v) =>
                onChange({ ...cond, operand: { kind: "attribute", target: v as AbacTarget, attribute: (cond.operand as any).attribute } })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TARGET_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={(cond.operand as any).attribute}
              onValueChange={(v) =>
                onChange({ ...cond, operand: { kind: "attribute", target: (cond.operand as any).target, attribute: v } })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ABAC_ATTRIBUTE_CATALOG.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <Input
            value={literalValue}
            placeholder="Value (comma-separated for a set)"
            onChange={(e) => {
              const raw = e.target.value
              const parts = raw.split(",").map((x) => x.trim()).filter(Boolean)
              const value: string | number | (string | number)[] =
                parts.length > 1
                  ? parts.map((p) => (p !== "" && !isNaN(Number(p)) ? Number(p) : p))
                  : raw !== "" && !isNaN(Number(raw))
                    ? Number(raw)
                    : raw
              onChange({ ...cond, operand: { kind: "literal", value } })
            }}
          />
        )}
      </div>

      {canRemove && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        </div>
      )}
    </div>
  )
}
