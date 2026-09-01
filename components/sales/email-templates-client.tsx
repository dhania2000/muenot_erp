"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDate } from "@/lib/utils"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, Search } from "lucide-react"
import { EmailTemplateDialog } from "@/components/sales/email-template-dialog"

export type EmailTemplateRow = {
  id: number
  name: string
  subject: string
  body: string
  category: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
  attachment_pathname?: string | null
  attachment_name?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
}

export function EmailTemplatesClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ templates: EmailTemplateRow[] }>(
    "/api/sales/email-templates",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EmailTemplateRow | null>(null)

  const templates = data?.templates ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return templates
    return templates.filter((t) =>
      [t.name, t.subject, t.category].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    )
  }, [templates, search])

  async function deleteTemplate(t: EmailTemplateRow) {
    if (!confirm(`Delete template "${t.name}"?`)) return
    const res = await fetch(`/api/sales/email-templates/${t.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Template deleted")
      mutate()
    } else {
      toast.error("Unable to delete template")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Create template
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Updated</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
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
                  {t.category ? <Badge variant="outline">{t.category}</Badge> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(t.updated_at)}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(t)
                            setDialogOpen(true)
                          }}
                        >
                          Edit template
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteTemplate(t)}>
                          Delete template
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <EmailTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Template updated" : "Template created")
          mutate()
        }}
      />
    </div>
  )
}
