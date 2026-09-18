"use client"

/**
 * SPEC 6 — Organization hierarchy UI.
 * ---------------------------------------------------------------------------
 * Client surface for the org-hierarchy backend (lib/org-hierarchy.ts + the
 * /api/org/* routes). Renders the enterprise structure as an expandable tree
 * of typed units, and — when the caller has manage rights — supports creating,
 * editing, re-parenting and deleting units plus assigning users to units.
 *
 * All mutations go through the tenant-scoped, permission-gated API routes; this
 * component never touches the database directly.
 */

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Crown,
  Network,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react"

// ── Types (mirror the API shapes; org-hierarchy.ts is server-only) ─────────────

const ORG_UNIT_TYPES = [
  "organization",
  "legal_entity",
  "group",
  "business_unit",
  "division",
  "department",
  "team",
  "branch",
  "location",
  "cost_center",
  "profit_center",
] as const

type OrgUnitType = (typeof ORG_UNIT_TYPES)[number]

const TYPE_LABELS: Record<OrgUnitType, string> = {
  organization: "Organization",
  legal_entity: "Legal Entity",
  group: "Group",
  business_unit: "Business Unit",
  division: "Division",
  department: "Department",
  team: "Team",
  branch: "Branch",
  location: "Location",
  cost_center: "Cost Center",
  profit_center: "Profit Center",
}

const TYPE_STYLES: Record<OrgUnitType, string> = {
  organization: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  legal_entity: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  group: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  business_unit: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  division: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  department: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  team: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  branch: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  location: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  cost_center: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  profit_center: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
}

type OrgUnit = {
  id: number
  unit_code: string
  name: string
  unit_type: OrgUnitType
  parent_id: number | null
  path: string
  depth: number
  head_user_id: number | null
  external_code: string | null
  description: string | null
  status: "active" | "inactive"
  sort_order: number
  head_name: string | null
  member_count: number
}

type OrgUnitNode = OrgUnit & { children: OrgUnitNode[] }

type UserRow = { id: number; name: string | null; email: string | null; role: string | null }

type AssignmentRow = {
  id: number
  org_unit_id: number
  user_id: number
  assignment_title: string | null
  is_primary: number
  user_name: string | null
  user_email: string | null
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || "Request failed")
  return body
}

function TypeBadge({ type }: { type: OrgUnitType }) {
  return (
    <Badge variant="secondary" className={TYPE_STYLES[type] ?? ""}>
      {TYPE_LABELS[type] ?? type}
    </Badge>
  )
}

// Flatten a tree to a list of { unit, indentLabel } for parent pickers.
function flattenTree(nodes: OrgUnitNode[], depth = 0, acc: Array<{ unit: OrgUnitNode; depth: number }> = []) {
  for (const n of nodes) {
    acc.push({ unit: n, depth })
    if (n.children.length) flattenTree(n.children, depth + 1, acc)
  }
  return acc
}

// The next-broader-to-narrower type suggestion for a child of `parentType`.
function suggestChildType(parentType: OrgUnitType | null): OrgUnitType {
  if (!parentType) return "organization"
  const idx = ORG_UNIT_TYPES.indexOf(parentType)
  return ORG_UNIT_TYPES[Math.min(idx + 1, ORG_UNIT_TYPES.length - 1)]
}

// ── Unit create / edit dialog ──────────────────────────────────────────────────

type UnitFormState = {
  name: string
  unit_type: OrgUnitType
  parent_id: string // "" for none
  head_user_id: string // "" for none
  external_code: string
  description: string
  status: "active" | "inactive"
}

function UnitDialog({
  open,
  mode,
  unit,
  defaultParentId,
  defaultParentType,
  units,
  users,
  onOpenChange,
  onDone,
}: {
  open: boolean
  mode: "create" | "edit"
  unit: OrgUnit | null
  defaultParentId: number | null
  defaultParentType: OrgUnitType | null
  units: OrgUnit[]
  users: UserRow[]
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const initial: UnitFormState = useMemo(() => {
    if (mode === "edit" && unit) {
      return {
        name: unit.name,
        unit_type: unit.unit_type,
        parent_id: unit.parent_id ? String(unit.parent_id) : "",
        head_user_id: unit.head_user_id ? String(unit.head_user_id) : "",
        external_code: unit.external_code ?? "",
        description: unit.description ?? "",
        status: unit.status,
      }
    }
    return {
      name: "",
      unit_type: suggestChildType(defaultParentType),
      parent_id: defaultParentId ? String(defaultParentId) : "",
      head_user_id: "",
      external_code: "",
      description: "",
      status: "active",
    }
    // Re-derive whenever the dialog is (re)opened for a different target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const [form, setForm] = useState<UnitFormState>(initial)
  const [saving, setSaving] = useState(false)

  // Keep local state in sync when the memoized initial changes (dialog reopen).
  const [syncKey, setSyncKey] = useState(open)
  if (syncKey !== open) {
    setSyncKey(open)
    if (open) setForm(initial)
  }

  // In edit mode, a unit cannot be re-parented under itself or its descendants.
  const parentOptions = useMemo(() => {
    if (mode === "edit" && unit) {
      const selfPrefix = unit.path // "/3/7/"
      return units.filter((u) => u.id !== unit.id && !u.path.startsWith(selfPrefix))
    }
    return units
  }, [mode, unit, units])

  const set = <K extends keyof UnitFormState>(k: K, v: UnitFormState[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name.trim()) return toast.error("Name is required.")
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        unit_type: form.unit_type,
        parent_id: form.parent_id ? Number(form.parent_id) : null,
        head_user_id: form.head_user_id ? Number(form.head_user_id) : null,
        external_code: form.external_code.trim() || null,
        description: form.description.trim() || null,
        status: form.status,
      }
      const res = await fetch(mode === "create" ? "/api/org/units" : `/api/org/units/${unit!.id}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Save failed.")
      toast.success(mode === "create" ? "Unit created." : "Unit updated.")
      onOpenChange(false)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add Organizational Unit" : "Edit Unit"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create a new node in the enterprise structure."
              : "Update this unit's details or move it within the hierarchy."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. North America Sales"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select value={form.unit_type} onValueChange={(v) => set("unit_type", v as OrgUnitType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORG_UNIT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Parent unit</Label>
              <Select value={form.parent_id || "none"} onValueChange={(v) => set("parent_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="No parent (top level)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No parent (top level)</SelectItem>
                  {parentOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {"\u00A0".repeat(u.depth * 2)}
                      {u.name} · {TYPE_LABELS[u.unit_type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Unit head</Label>
              <Select
                value={form.head_user_id || "none"}
                onValueChange={(v) => set("head_user_id", v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name || u.email || `User #${u.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>External code</Label>
              <Input
                value={form.external_code}
                onChange={(e) => set("external_code", e.target.value)}
                placeholder="ERP / GL code"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={2} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label className="text-sm">Active</Label>
              <p className="text-xs text-muted-foreground">Inactive units stay in the tree but are flagged.</p>
            </div>
            <Switch
              checked={form.status === "active"}
              onCheckedChange={(v) => set("status", v ? "active" : "inactive")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : mode === "create" ? "Create unit" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Delete dialog (with subtree handling mode) ─────────────────────────────────

function DeleteDialog({
  unit,
  hasChildren,
  onClose,
  onDone,
}: {
  unit: OrgUnit | null
  hasChildren: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<"reparent" | "cascade">("reparent")
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    if (!unit) return
    setBusy(true)
    try {
      const qs = hasChildren ? `?mode=${mode}` : ""
      const res = await fetch(`/api/org/units/${unit.id}${qs}`, { method: "DELETE" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Delete failed.")
      toast.success("Unit deleted.")
      onClose()
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={!!unit} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{unit?.name}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasChildren
              ? "This unit has child units. Choose what happens to them."
              : "This will remove the unit and all of its user assignments. This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {hasChildren && (
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => setMode("reparent")}
              className={`rounded-md border p-3 text-left text-sm ${mode === "reparent" ? "border-primary ring-1 ring-primary" : ""}`}
            >
              <span className="font-medium">Keep child units</span>
              <p className="text-xs text-muted-foreground">Move direct children up to this unit&apos;s parent.</p>
            </button>
            <button
              type="button"
              onClick={() => setMode("cascade")}
              className={`rounded-md border p-3 text-left text-sm ${mode === "cascade" ? "border-destructive ring-1 ring-destructive" : ""}`}
            >
              <span className="font-medium text-destructive">Delete entire subtree</span>
              <p className="text-xs text-muted-foreground">Remove this unit and every descendant and their assignments.</p>
            </button>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              confirm()
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Assignments sheet ──────────────────────────────────────────────────────────

function AssignmentsSheet({
  unit,
  users,
  canManage,
  onClose,
}: {
  unit: OrgUnit | null
  users: UserRow[]
  canManage: boolean
  onClose: () => void
}) {
  const key = unit ? `/api/org/assignments?unit_id=${unit.id}` : null
  const { data, isLoading, mutate } = useSWR<{ assignments: AssignmentRow[] }>(key, fetcher)
  const [userId, setUserId] = useState("")
  const [title, setTitle] = useState("")
  const [isPrimary, setIsPrimary] = useState(false)
  const [saving, setSaving] = useState(false)
  const [userSearch, setUserSearch] = useState("")

  const assignments = data?.assignments ?? []
  const assignedIds = new Set(assignments.map((a) => a.user_id))
  const available = users.filter(
    (u) =>
      !assignedIds.has(u.id) &&
      (u.name || u.email || "").toLowerCase().includes(userSearch.trim().toLowerCase()),
  )

  const add = async () => {
    if (!unit || !userId) return toast.error("Select a user to assign.")
    setSaving(true)
    try {
      const res = await fetch("/api/org/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org_unit_id: unit.id,
          user_id: Number(userId),
          assignment_title: title.trim() || null,
          is_primary: isPrimary,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to assign.")
      toast.success("User assigned.")
      setUserId("")
      setTitle("")
      setIsPrimary(false)
      mutate()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (uid: number) => {
    if (!unit) return
    try {
      const res = await fetch(`/api/org/assignments?unit_id=${unit.id}&user_id=${uid}`, { method: "DELETE" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to remove.")
      toast.success("User removed.")
      mutate()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Sheet open={!!unit} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Users className="size-4" />
            {unit?.name}
          </SheetTitle>
          <SheetDescription>
            {unit ? TYPE_LABELS[unit.unit_type] : ""} · {unit?.unit_code} — manage the people assigned to this unit.
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-5 p-4">
          {canManage && (
            <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
              <h4 className="text-sm font-medium">Assign a user</h4>
              <Input placeholder="Search people…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a user" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name || u.email || `User #${u.id}`}
                      {u.role ? ` · ${u.role}` : ""}
                    </SelectItem>
                  ))}
                  {available.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching users</div>
                  )}
                </SelectContent>
              </Select>
              <Input placeholder="Role / title in this unit (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch checked={isPrimary} onCheckedChange={setIsPrimary} id="primary" />
                  <Label htmlFor="primary" className="text-sm">
                    Primary unit for this user
                  </Label>
                </div>
                <Button size="sm" onClick={add} disabled={saving}>
                  <UserPlus className="mr-1 size-4" />
                  {saving ? "Adding…" : "Assign"}
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <h4 className="text-sm font-medium">
              Members {assignments.length > 0 && <span className="text-muted-foreground">({assignments.length})</span>}
            </h4>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : assignments.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No users assigned to this unit yet.
              </div>
            ) : (
              assignments.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{a.user_name || a.user_email || `User #${a.user_id}`}</span>
                      {a.is_primary === 1 && (
                        <Badge variant="secondary" className="gap-1 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                          <Star className="size-3" />
                          Primary
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.assignment_title || "—"}
                      {a.user_email ? ` · ${a.user_email}` : ""}
                    </p>
                  </div>
                  {canManage && (
                    <Button size="icon" variant="ghost" onClick={() => remove(a.user_id)} aria-label="Remove user">
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Tree node ──────────────────────────────────────────────────────────────────

function TreeNode({
  node,
  depth,
  canManage,
  expanded,
  onToggle,
  onAddChild,
  onEdit,
  onDelete,
  onManage,
}: {
  node: OrgUnitNode
  depth: number
  canManage: boolean
  expanded: Set<number>
  onToggle: (id: number) => void
  onAddChild: (parent: OrgUnitNode) => void
  onEdit: (unit: OrgUnitNode) => void
  onDelete: (unit: OrgUnitNode) => void
  onManage: (unit: OrgUnitNode) => void
}) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)

  return (
    <div>
      <div
        className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/60"
        style={{ paddingLeft: depth * 20 + 8 }}
      >
        <button
          type="button"
          onClick={() => hasChildren && onToggle(node.id)}
          className={`flex size-5 shrink-0 items-center justify-center rounded ${hasChildren ? "hover:bg-muted" : "invisible"}`}
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <Building2 className="size-4 shrink-0 text-muted-foreground" />

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{node.name}</span>
          <TypeBadge type={node.unit_type} />
          {node.status === "inactive" && (
            <Badge variant="outline" className="text-muted-foreground">
              Inactive
            </Badge>
          )}
          {node.head_name && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Crown className="size-3" />
              {node.head_name}
            </span>
          )}
          <button
            type="button"
            onClick={() => onManage(node)}
            className="inline-flex items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Users className="size-3" />
            {node.member_count}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="icon" variant="ghost" className="size-7" onClick={() => onManage(node)} aria-label="Manage members">
            <Users className="size-4" />
          </Button>
          {canManage && (
            <>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => onAddChild(node)} aria-label="Add child unit">
                <Plus className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => onEdit(node)} aria-label="Edit unit">
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-destructive hover:text-destructive"
                onClick={() => onDelete(node)}
                aria-label="Delete unit"
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {isOpen &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            canManage={canManage}
            expanded={expanded}
            onToggle={onToggle}
            onAddChild={onAddChild}
            onEdit={onEdit}
            onDelete={onDelete}
            onManage={onManage}
          />
        ))}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function OrgHierarchyClient({ canManage }: { canManage: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<{ tree: OrgUnitNode[] }>("/api/org/units?shape=tree", fetcher)
  const { data: usersData } = useSWR<{ users: UserRow[] }>("/api/org/users", fetcher)

  const tree = data?.tree ?? []
  const users = usersData?.users ?? []
  const flat = useMemo(() => flattenTree(tree).map((f) => f.unit), [tree])

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [initialised, setInitialised] = useState(false)
  const [search, setSearch] = useState("")

  // Expand all roots + their direct children on first load for a useful default.
  if (!initialised && tree.length > 0) {
    const next = new Set<number>()
    for (const root of tree) {
      next.add(root.id)
      for (const child of root.children) next.add(child.id)
    }
    setExpanded(next)
    setInitialised(true)
  }

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const allIds = useMemo(() => flat.map((u) => u.id), [flat])
  const expandAll = () => setExpanded(new Set(allIds))
  const collapseAll = () => setExpanded(new Set())

  // Filtered tree: when searching, prune to matching nodes + their ancestors.
  const filteredTree = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tree
    const matches = (n: OrgUnitNode): OrgUnitNode | null => {
      const kids = n.children.map(matches).filter(Boolean) as OrgUnitNode[]
      const self =
        n.name.toLowerCase().includes(q) ||
        n.unit_code.toLowerCase().includes(q) ||
        TYPE_LABELS[n.unit_type].toLowerCase().includes(q) ||
        (n.head_name ?? "").toLowerCase().includes(q)
      if (self || kids.length) return { ...n, children: kids }
      return null
    }
    return tree.map(matches).filter(Boolean) as OrgUnitNode[]
  }, [tree, search])

  // When a search is active, expand everything that survived the prune.
  const searchExpanded = useMemo(() => {
    if (!search.trim()) return expanded
    const ids = new Set<number>()
    const walk = (nodes: OrgUnitNode[]) => nodes.forEach((n) => (ids.add(n.id), walk(n.children)))
    walk(filteredTree)
    return ids
  }, [search, filteredTree, expanded])

  // Dialog / sheet state.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create")
  const [editUnit, setEditUnit] = useState<OrgUnit | null>(null)
  const [defaultParent, setDefaultParent] = useState<OrgUnitNode | null>(null)
  const [deleteUnit, setDeleteUnit] = useState<OrgUnitNode | null>(null)
  const [manageUnit, setManageUnit] = useState<OrgUnitNode | null>(null)

  const openCreateRoot = () => {
    setDialogMode("create")
    setEditUnit(null)
    setDefaultParent(null)
    setDialogOpen(true)
  }
  const openAddChild = (parent: OrgUnitNode) => {
    setDialogMode("create")
    setEditUnit(null)
    setDefaultParent(parent)
    setDialogOpen(true)
  }
  const openEdit = (unit: OrgUnitNode) => {
    setDialogMode("edit")
    setEditUnit(unit)
    setDefaultParent(null)
    setDialogOpen(true)
  }

  const totalUnits = flat.length
  const totalMembers = flat.reduce((s, u) => s + (u.member_count || 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Network className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Organization Hierarchy</h1>
            <p className="text-sm text-muted-foreground">
              Model your enterprise structure — from legal entities down to teams, locations and cost centers.
            </p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openCreateRoot}>
            <Plus className="mr-1 size-4" />
            Add unit
          </Button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <Building2 className="size-4 text-muted-foreground" />
            <span className="text-2xl font-semibold tabular-nums">{totalUnits}</span>
            <span className="text-xs text-muted-foreground">Units</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <Users className="size-4 text-muted-foreground" />
            <span className="text-2xl font-semibold tabular-nums">{totalMembers}</span>
            <span className="text-xs text-muted-foreground">Assignments</span>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardContent className="flex flex-col gap-1 p-4">
            <Network className="size-4 text-muted-foreground" />
            <span className="text-2xl font-semibold tabular-nums">{tree.length}</span>
            <span className="text-xs text-muted-foreground">Top-level entities</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search units, codes, heads…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={expandAll}>
                Expand all
              </Button>
              <Button size="sm" variant="ghost" onClick={collapseAll}>
                Collapse all
              </Button>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center text-sm text-destructive">
              Failed to load the hierarchy. {(error as Error).message}
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Network className="size-6 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">No organizational units yet</p>
                <p className="text-sm text-muted-foreground">
                  Start by adding your top-level organization or legal entity.
                </p>
              </div>
              {canManage && (
                <Button onClick={openCreateRoot}>
                  <Plus className="mr-1 size-4" />
                  Add your first unit
                </Button>
              )}
            </div>
          ) : filteredTree.length === 0 ? (
            <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
              No units match &quot;{search}&quot;.
            </div>
          ) : (
            <div className="-mx-1">
              {filteredTree.map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  canManage={canManage}
                  expanded={search.trim() ? searchExpanded : expanded}
                  onToggle={toggle}
                  onAddChild={openAddChild}
                  onEdit={openEdit}
                  onDelete={setDeleteUnit}
                  onManage={setManageUnit}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <UnitDialog
        open={dialogOpen}
        mode={dialogMode}
        unit={editUnit}
        defaultParentId={defaultParent?.id ?? null}
        defaultParentType={defaultParent?.unit_type ?? null}
        units={flat}
        users={users}
        onOpenChange={setDialogOpen}
        onDone={() => mutate()}
      />

      <DeleteDialog
        unit={deleteUnit}
        hasChildren={!!deleteUnit && deleteUnit.children.length > 0}
        onClose={() => setDeleteUnit(null)}
        onDone={() => mutate()}
      />

      <AssignmentsSheet
        unit={manageUnit}
        users={users}
        canManage={canManage}
        onClose={() => {
          setManageUnit(null)
          mutate()
        }}
      />
    </div>
  )
}
