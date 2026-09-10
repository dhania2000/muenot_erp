"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Mail, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"
import { formatDate } from "@/lib/recruit"
import {
  RecruitEmailTemplateDialog,
  type RecruitTemplateRow,
} from "@/components/recruit/recruit-email-template-dialog"

export function RecruitEmailTemplatesClient() {
  const { data, isLoading, mutate } = useSWR<{ templates: RecruitTemplateRow[] }>(
    "/api/recruit/email-templates",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RecruitTemplateRow | null>(null)

  const templates = data?.templates ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return templates
    return templates.filter((t) =>
      [t.name, t.subject, t.category].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    )
  }, [templates, search])

  async function remove(t: RecruitTemplateRow) {
    if (!confirm(`Delete template "${t.name}"?`)) return
    const res = await fetch(`/api/recruit/email-templates/${t.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Template deleted")
      mutate()
    } else {
      toast.error("Unable to delete template")
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Email Templates"
        description="Reusable emails for reaching out to candidates."
        icon={Mail}
        action={
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus data-icon="inline-start" /> Create template
          </Button>
        }
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search templates..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 pl-8"
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  Loading templates...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No templates yet.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">{t.subject}</TableCell>
                <TableCell>
                  {t.category ? (
                    <Badge variant="outline">{t.category}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate((t as any).updated_at as unknown as string)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit template"
                      onClick={() => {
                        setEditing(t)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete template" onClick={() => remove(t)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RecruitEmailTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Template updated" : "Template created")
          mutate()
        }}
      />
    </main>
  )
}
