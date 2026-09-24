"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Pencil, Database, AlertCircle, Upload, Archive, Table2 } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { ModuleDefinition, ModuleStatus } from "@/lib/custom-modules/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ModuleBuilderDialog } from "./module-builder-dialog"
import { ModuleRecordsDialog } from "./module-records-dialog"

type RoleOpt = { role: string; label: string }
type FieldTypeDef = {
  type: string
  label: string
  description: string
  category: string
  hasOptions: boolean
  isRelation: boolean
  computed: boolean
  numeric: boolean
}

export type Catalogue = {
  fieldTypes: FieldTypeDef[]
  reportOps: string[]
  roles: RoleOpt[]
}

type ListResponse = { modules: ModuleDefinition[]; catalogue: Catalogue }

const STATUS_BADGE: Record<ModuleStatus, { label: string; className?: string; variant?: "outline" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  published: { label: "Published", className: "bg-emerald-600 hover:bg-emerald-600" },
  archived: { label: "Archived", variant: "outline" },
}

export function CustomModulesClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>("/api/admin/custom-modules", fetcher)
  const [editing, setEditing] = useState<ModuleDefinition | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<ModuleDefinition | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const catalogue = data?.catalogue
  const modules = useMemo(() => data?.modules ?? [], [data])

  async function changeStatus(module: ModuleDefinition, status: ModuleStatus) {
    if (!module.id) return
    setBusyId(module.id)
    try {
      const res = await fetch(`/api/admin/custom-modules/${module.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (res.ok) await mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function remove(module: ModuleDefinition) {
    if (!module.id) return
    if (!window.confirm(`Delete "${module.name}" and all of its records? This cannot be undone.`)) return
    setBusyId(module.id)
    try {
      const res = await fetch(`/api/admin/custom-modules/${module.id}`, { method: "DELETE" })
      if (res.ok) await mutate()
    } finally {
      setBusyId(null)
    }
  }

  if (error) {
    return (
      <Card className="flex items-center gap-3 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <span>You do not have access to custom-module administration, or it failed to load.</span>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {modules.length === 0 ? "No modules yet" : `${modules.length} module${modules.length === 1 ? "" : "s"}`}
        </p>
        <Button onClick={() => setCreating(true)} disabled={!catalogue}>
          <Plus className="mr-1.5 h-4 w-4" />
          New module
        </Button>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : modules.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <Database className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No custom modules yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Define a new entity with its own fields, permissions, workflow and reports — no code
              required.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Structure</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-72 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {modules.map((module) => {
                const badge = STATUS_BADGE[module.status]
                return (
                  <TableRow key={module.id ?? module.slug}>
                    <TableCell>
                      <div className="font-medium">{module.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">/{module.slug}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {module.fields.length} field{module.fields.length === 1 ? "" : "s"}
                      {module.reports.length > 0 && ` · ${module.reports.length} report${module.reports.length === 1 ? "" : "s"}`}
                      {module.allowAttachments && " · attachments"}
                    </TableCell>
                    <TableCell>
                      {module.workflow.enabled ? (
                        <Badge variant="outline">{module.workflow.states.length} states</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant} className={badge.className}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {module.status !== "published" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === module.id}
                            onClick={() => changeStatus(module, "published")}
                          >
                            <Upload className="mr-1 h-3.5 w-3.5" />
                            Publish
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === module.id}
                            onClick={() => changeStatus(module, "archived")}
                          >
                            <Archive className="mr-1 h-3.5 w-3.5" />
                            Archive
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={module.status !== "published"}
                          onClick={() => setViewing(module)}
                        >
                          <Table2 className="mr-1 h-3.5 w-3.5" />
                          Records
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${module.name}`}
                          onClick={() => setEditing(module)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${module.name}`}
                          disabled={busyId === module.id}
                          onClick={() => remove(module)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {catalogue && (creating || editing) && (
        <ModuleBuilderDialog
          open
          catalogue={catalogue}
          existing={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={() => {
            setCreating(false)
            setEditing(null)
            void mutate()
          }}
        />
      )}

      {viewing && (
        <ModuleRecordsDialog module={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  )
}
