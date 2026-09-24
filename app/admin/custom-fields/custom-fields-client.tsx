"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Pencil, SlidersHorizontal, AlertCircle } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { FieldDefinition, FieldOption } from "@/lib/custom-fields/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { FieldEditorDialog } from "./field-editor-dialog"
import { DeleteFieldDialog } from "./delete-field-dialog"

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
type EntityDef = { entityType: string; label: string; module: string }
type RoleOpt = { role: string; label: string }

export type Catalogue = {
  fieldTypes: FieldTypeDef[]
  entities: EntityDef[]
  roles: RoleOpt[]
}

type ListResponse = { fields: FieldDefinition[]; catalogue: Catalogue }

const ROLE_LABEL: Record<string, string> = {
  employee: "Employee",
  module_admin: "Module admin",
  tenant_admin: "Tenant admin",
  tenant_owner: "Tenant owner",
}

export function CustomFieldsClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(
    "/api/admin/custom-fields",
    fetcher,
  )
  const [entityFilter, setEntityFilter] = useState<string>("all")
  const [editing, setEditing] = useState<FieldDefinition | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<FieldDefinition | null>(null)

  const catalogue = data?.catalogue
  const fields = useMemo(() => data?.fields ?? [], [data])

  const visible = useMemo(() => {
    const list =
      entityFilter === "all" ? fields : fields.filter((f) => f.entityType === entityFilter)
    return [...list].sort(
      (a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.sortOrder - b.sortOrder ||
        a.label.localeCompare(b.label),
    )
  }, [fields, entityFilter])

  const entityLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of catalogue?.entities ?? []) m.set(e.entityType, e.label)
    return m
  }, [catalogue])

  const typeLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of catalogue?.fieldTypes ?? []) m.set(t.type, t.label)
    return m
  }, [catalogue])

  if (error) {
    return (
      <Card className="flex items-center gap-3 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <span>You do not have access to custom-field administration, or it failed to load.</span>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Entity</span>
          <Select value={entityFilter} onValueChange={setEntityFilter}>
            <SelectTrigger className="w-56" aria-label="Filter by entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entities</SelectItem>
              {(catalogue?.entities ?? []).map((e) => (
                <SelectItem key={e.entityType} value={e.entityType}>
                  {e.label} · {e.module}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreating(true)} disabled={!catalogue}>
          <Plus className="mr-1.5 h-4 w-4" />
          New field
        </Button>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <SlidersHorizontal className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No custom fields yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Define a field to extend any module&apos;s records — no code required.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((f) => (
                <TableRow key={`${f.entityType}:${f.key}`}>
                  <TableCell>
                    <div className="font-medium">{f.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{f.key}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {entityLabel.get(f.entityType) ?? f.entityType}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{typeLabel.get(f.type) ?? f.type}</Badge>
                    {f.required && (
                      <Badge variant="outline" className="ml-1.5">
                        Required
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div>View: {ROLE_LABEL[f.viewMinRole] ?? f.viewMinRole}</div>
                    <div>Edit: {ROLE_LABEL[f.editMinRole] ?? f.editMinRole}</div>
                  </TableCell>
                  <TableCell>
                    {f.active ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Active</Badge>
                    ) : (
                      <Badge variant="outline">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${f.label}`}
                        onClick={() => setEditing(f)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${f.label}`}
                        onClick={() => setDeleting(f)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {catalogue && (creating || editing) && (
        <FieldEditorDialog
          open
          catalogue={catalogue}
          existing={editing}
          siblings={fields}
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

      {deleting && (
        <DeleteFieldDialog
          field={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            void mutate()
          }}
        />
      )}
    </div>
  )
}

export { ROLE_LABEL }
export type { FieldOption }
