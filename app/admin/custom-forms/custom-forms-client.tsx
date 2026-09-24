"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Pencil, FileText, AlertCircle, Inbox, Send, Archive, Upload } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { FormDefinition, FormStatus } from "@/lib/custom-forms/model"
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
import { FormBuilderDialog } from "./form-builder-dialog"
import { SubmissionsDialog } from "./submissions-dialog"
import { DeleteFormDialog } from "./delete-form-dialog"

type RoleOpt = { role: string; label: string }
type FieldTypeDef = {
  type: string
  label: string
  description: string
  hasOptions: boolean
  multiValue: boolean
  isAttachment: boolean
}
type OperatorDef = { op: string; label: string; needsValue: boolean }

export type Catalogue = {
  fieldTypes: FieldTypeDef[]
  operators: OperatorDef[]
  roles: RoleOpt[]
}

type ListResponse = { forms: FormDefinition[]; catalogue: Catalogue }

const STATUS_BADGE: Record<FormStatus, { label: string; className?: string; variant?: "outline" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  published: { label: "Published", className: "bg-emerald-600 hover:bg-emerald-600" },
  archived: { label: "Archived", variant: "outline" },
}

export function CustomFormsClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>("/api/admin/custom-forms", fetcher)
  const [editing, setEditing] = useState<FormDefinition | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<FormDefinition | null>(null)
  const [deleting, setDeleting] = useState<FormDefinition | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const catalogue = data?.catalogue
  const forms = useMemo(() => data?.forms ?? [], [data])

  async function changeStatus(form: FormDefinition, status: FormStatus) {
    if (!form.id) return
    setBusyId(form.id)
    try {
      const res = await fetch(`/api/admin/custom-forms/${form.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (res.ok) await mutate()
    } finally {
      setBusyId(null)
    }
  }

  if (error) {
    return (
      <Card className="flex items-center gap-3 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <span>You do not have access to custom-form administration, or it failed to load.</span>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {forms.length === 0 ? "No forms yet" : `${forms.length} form${forms.length === 1 ? "" : "s"}`}
        </p>
        <Button onClick={() => setCreating(true)} disabled={!catalogue}>
          <Plus className="mr-1.5 h-4 w-4" />
          New form
        </Button>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : forms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No custom forms yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Build a form with sections, conditional fields and an approval workflow — no code
              required.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Form</TableHead>
                <TableHead>Structure</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-64 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.map((form) => {
                const badge = STATUS_BADGE[form.status]
                const fieldCount = form.sections.reduce((n, s) => n + s.fields.length, 0)
                return (
                  <TableRow key={form.id ?? form.slug}>
                    <TableCell>
                      <div className="font-medium">{form.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">/{form.slug}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {form.sections.length} section{form.sections.length === 1 ? "" : "s"} · {fieldCount}{" "}
                      field{fieldCount === 1 ? "" : "s"}
                    </TableCell>
                    <TableCell>
                      {form.approval.enabled ? (
                        <Badge variant="outline">Requires approval</Badge>
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
                        {form.status !== "published" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === form.id}
                            onClick={() => changeStatus(form, "published")}
                          >
                            <Upload className="mr-1 h-3.5 w-3.5" />
                            Publish
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === form.id}
                            onClick={() => changeStatus(form, "archived")}
                          >
                            <Archive className="mr-1 h-3.5 w-3.5" />
                            Archive
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setViewing(form)}>
                          <Inbox className="mr-1 h-3.5 w-3.5" />
                          Submissions
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${form.title}`}
                          onClick={() => setEditing(form)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${form.title}`}
                          onClick={() => setDeleting(form)}
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
        <FormBuilderDialog
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

      {viewing && catalogue && (
        <SubmissionsDialog
          form={viewing}
          roles={catalogue.roles}
          onClose={() => setViewing(null)}
        />
      )}

      {deleting && (
        <DeleteFormDialog
          form={deleting}
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
