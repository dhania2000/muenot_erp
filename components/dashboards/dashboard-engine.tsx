"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { LayoutDashboard, Pencil, Plus, Save, Trash2, X } from "lucide-react"
import { WidgetCard } from "./widget-card"
import { WidgetPicker } from "./widget-picker"
import { DashboardFilterBar } from "./dashboard-filters"
import { SaveDashboardDialog, type SaveDialogValue } from "./save-dashboard-dialog"
import {
  ROLE_KEY_LABELS,
  resolveDatePreset,
  type DashboardBootstrap,
  type DashboardConfig,
  type DashboardFilters,
  type DashboardRecord,
  type WidgetCatalogEntry,
  type WidgetData,
  type WidgetInstance,
} from "@/lib/dashboards/types"

const SPAN: Record<WidgetCatalogEntry["size"], string> = {
  sm: "md:col-span-1",
  md: "md:col-span-1 lg:col-span-1",
  lg: "md:col-span-2 lg:col-span-2",
}

let instanceCounter = 0
function newInstanceId(key: string): string {
  instanceCounter += 1
  return `${key}-${Date.now().toString(36)}-${instanceCounter}`
}

function defaultFilters(): DashboardFilters {
  const { from, to } = resolveDatePreset("last_30")
  return { preset: "last_30", from, to, department: null, modules: null }
}

function scopeLabel(d: DashboardRecord): string {
  if (d.scope === "personal") return "Personal"
  if (d.scope === "tenant") return "Organization"
  return ROLE_KEY_LABELS[d.roleKey ?? ""] ?? "Role"
}

export function DashboardEngine() {
  const { data: bootstrap, isLoading, mutate: mutateBootstrap } = useSWR<DashboardBootstrap>(
    "/api/dashboards",
    fetcher,
  )

  const catalog = bootstrap?.catalog ?? []
  const catalogMap = useMemo(() => new Map(catalog.map((c) => [c.key, c])), [catalog])
  const dashboards = bootstrap?.dashboards ?? []
  const departments = bootstrap?.options.departments ?? []
  const canManageShared = bootstrap?.permissions.canManageShared ?? false

  const [selectedId, setSelectedId] = useState<number | "new">("new")
  const [widgets, setWidgets] = useState<WidgetInstance[]>([])
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters)
  const [editMode, setEditMode] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DashboardRecord | null>(null)
  const dragIndex = useRef<number | null>(null)

  // Load a dashboard config into local editing state.
  const loadDashboard = useCallback(
    (record: DashboardRecord | null) => {
      if (!record) {
        setWidgets([])
        setFilters(defaultFilters())
        setEditMode(true)
        setDirty(false)
        return
      }
      setWidgets(record.config.widgets.map((w) => ({ id: w.id || newInstanceId(w.key), key: w.key })))
      setFilters({ ...defaultFilters(), ...record.config.filters })
      setEditMode(false)
      setDirty(false)
    },
    [],
  )

  // Pick an initial dashboard once bootstrap arrives.
  const initialized = useRef(false)
  useEffect(() => {
    if (!bootstrap || initialized.current) return
    initialized.current = true
    const first = dashboards.find((d) => d.isDefault) ?? dashboards[0]
    if (first) {
      setSelectedId(first.id)
      loadDashboard(first)
    } else {
      setSelectedId("new")
      loadDashboard(null)
    }
  }, [bootstrap, dashboards, loadDashboard])

  const selected = typeof selectedId === "number" ? dashboards.find((d) => d.id === selectedId) ?? null : null
  const canEditCurrent = selectedId === "new" || (selected?.canEdit ?? false)

  function handleSelect(value: string) {
    if (value === "new") {
      setSelectedId("new")
      loadDashboard(null)
      return
    }
    const record = dashboards.find((d) => d.id === Number(value)) ?? null
    setSelectedId(record ? record.id : "new")
    loadDashboard(record)
  }

  function addWidget(entry: WidgetCatalogEntry) {
    setWidgets((prev) => [...prev, { id: newInstanceId(entry.key), key: entry.key }])
    setDirty(true)
  }
  function removeWidget(id: string) {
    setWidgets((prev) => prev.filter((w) => w.id !== id))
    setDirty(true)
  }
  function reorder(from: number, to: number) {
    setWidgets((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setDirty(true)
  }

  function updateFilters(next: DashboardFilters) {
    setFilters(next)
    setDirty(true)
  }

  const currentConfig: DashboardConfig = useMemo(() => ({ widgets, filters }), [widgets, filters])

  async function persist(value: SaveDialogValue, asNew: boolean) {
    setSaving(true)
    try {
      const payload = {
        name: value.name,
        scope: value.scope,
        roleKey: value.roleKey,
        config: currentConfig,
      }
      if (asNew) {
        const res = await fetch("/api/dashboards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Save failed")
        const { id } = await res.json()
        toast.success("Dashboard created")
        setSaveOpen(false)
        setDirty(false)
        setEditMode(false)
        const updated = await mutateBootstrap()
        const record = updated?.dashboards.find((d) => d.id === id) ?? null
        if (record) {
          setSelectedId(id)
          loadDashboard(record)
        }
      } else if (selected) {
        const res = await fetch(`/api/dashboards/${selected.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Save failed")
        toast.success("Dashboard saved")
        setSaveOpen(false)
        setDirty(false)
        setEditMode(false)
        await mutateBootstrap()
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function handleSaveClick() {
    // Existing editable dashboard → save in place; otherwise open the dialog.
    if (selected && selected.canEdit) {
      void persist({ name: selected.name, scope: selected.scope, roleKey: selected.roleKey }, false)
    } else {
      setSaveOpen(true)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      const res = await fetch(`/api/dashboards/${deleteTarget.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Delete failed")
      toast.success("Dashboard deleted")
      setDeleteTarget(null)
      const updated = await mutateBootstrap()
      const next = updated?.dashboards.find((d) => d.isDefault) ?? updated?.dashboards[0] ?? null
      if (next) {
        setSelectedId(next.id)
        loadDashboard(next)
      } else {
        setSelectedId("new")
        loadDashboard(null)
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // Resolve widget data for the visible widgets under the current filters.
  const visibleKeys = useMemo(
    () => widgets.map((w) => w.key).filter((k) => catalogMap.has(k)),
    [widgets, catalogMap],
  )
  const dataKey = useMemo(
    () =>
      visibleKeys.length
        ? JSON.stringify({ keys: [...new Set(visibleKeys)].sort(), f: filters })
        : null,
    [visibleKeys, filters],
  )
  const { data: widgetData, isLoading: dataLoading } = useSWR<{ data: Record<string, WidgetData> }>(
    dataKey,
    async () => {
      const res = await fetch("/api/dashboards/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [...new Set(visibleKeys)], filters }),
      })
      if (!res.ok) throw new Error("Failed to load widget data")
      return res.json()
    },
    { keepPreviousData: true },
  )

  const groupedOptions = useMemo(() => {
    const personal = dashboards.filter((d) => d.scope === "personal")
    const role = dashboards.filter((d) => d.scope === "role")
    const tenant = dashboards.filter((d) => d.scope === "tenant")
    return { personal, role, tenant }
  }, [dashboards])

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading dashboards…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={String(selectedId)} onValueChange={handleSelect}>
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="Select a dashboard" />
            </SelectTrigger>
            <SelectContent>
              {groupedOptions.personal.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Personal</SelectLabel>
                  {groupedOptions.personal.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {groupedOptions.role.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Role dashboards</SelectLabel>
                  {groupedOptions.role.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {groupedOptions.tenant.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Organization</SelectLabel>
                  {groupedOptions.tenant.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              <SelectSeparator />
              <SelectItem value="new">+ New dashboard</SelectItem>
            </SelectContent>
          </Select>
          {selected ? <Badge variant="secondary">{scopeLabel(selected)}</Badge> : null}
          {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
        </div>

        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <Plus className="mr-1.5 size-4" />
                Add widget
              </Button>
              {selectedId === "new" || !selected?.canEdit ? (
                <Button size="sm" onClick={() => setSaveOpen(true)}>
                  <Save className="mr-1.5 size-4" />
                  Save as…
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
                    Save as…
                  </Button>
                  <Button size="sm" onClick={handleSaveClick} disabled={saving}>
                    <Save className="mr-1.5 size-4" />
                    Save
                  </Button>
                </>
              )}
              {selected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    loadDashboard(selected)
                  }}
                >
                  <X className="mr-1.5 size-4" />
                  Cancel
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditMode(true)} disabled={!canEditCurrent}>
                <Pencil className="mr-1.5 size-4" />
                Edit
              </Button>
              {selected?.canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(selected)}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete dashboard</span>
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <DashboardFilterBar filters={filters} departments={departments} onChange={updateFilters} />

      {/* Widgets */}
      {widgets.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard className="size-6" />
            </EmptyMedia>
            <EmptyTitle>No widgets yet</EmptyTitle>
            <EmptyDescription>
              {editMode
                ? "Add KPIs, charts and tables from the widget library to build your dashboard."
                : "This dashboard is empty. Switch to edit mode to add widgets."}
            </EmptyDescription>
          </EmptyHeader>
          {editMode ? (
            <Button onClick={() => setPickerOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Add your first widget
            </Button>
          ) : (
            canEditCurrent && (
              <Button variant="outline" onClick={() => setEditMode(true)}>
                <Pencil className="mr-1.5 size-4" />
                Edit dashboard
              </Button>
            )
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-2">
          {widgets.map((w, index) => {
            const entry = catalogMap.get(w.key)
            if (!entry) return null
            return (
              <div
                key={w.id}
                className={cn(SPAN[entry.size])}
                onDragOver={(e) => {
                  if (editMode && dragIndex.current !== null) e.preventDefault()
                }}
                onDrop={(e) => {
                  if (!editMode || dragIndex.current === null) return
                  e.preventDefault()
                  if (dragIndex.current !== index) reorder(dragIndex.current, index)
                  dragIndex.current = null
                }}
              >
                <WidgetCard
                  entry={entry}
                  data={widgetData?.data[w.key]}
                  loading={dataLoading && !widgetData?.data[w.key]}
                  editMode={editMode}
                  onRemove={() => removeWidget(w.id)}
                  dragProps={{
                    draggable: editMode,
                    onDragStart: () => {
                      dragIndex.current = index
                    },
                    onDragEnd: () => {
                      dragIndex.current = null
                    },
                  }}
                />
              </div>
            )
          })}
        </div>
      )}

      <WidgetPicker open={pickerOpen} onOpenChange={setPickerOpen} catalog={catalog} onAdd={addWidget} />

      <SaveDashboardDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        initial={{
          name: selected && selected.canEdit ? selected.name : "",
          scope: selected?.scope ?? "personal",
          roleKey: selected?.roleKey ?? null,
        }}
        canManageShared={canManageShared}
        saving={saving}
        onSubmit={(value) => persist(value, true)}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the saved dashboard. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
