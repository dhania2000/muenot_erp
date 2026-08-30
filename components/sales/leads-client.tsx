"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
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
import { LeadDialog } from "@/components/sales/lead-dialog"

export type LeadRow = {
  id: number
  lead_code: string
  lead_date: string | null
  contact_person: string | null
  contact_number: string | null
  email: string | null
  designation: string | null
  lead_source: string | null
  company_name: string | null
  industry: string | null
  website: string | null
  company_email: string | null
  country: string | null
  assigned_to: number | null
  assigned_to_name: string | null
  status: string
  follow_up_date: string | null
  last_contact_date: string | null
  lead_health_score: number
  remarks: string | null
  created_at: string
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "followups", label: "Follow-ups" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
] as const

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  New: "outline",
  "Follow Up 1": "secondary",
  "Follow Up 2": "secondary",
  "In Discussion": "default",
  "Proposal Sent": "default",
  Ready: "default",
  Won: "default",
  Lost: "destructive",
}

export function LeadsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ leads: LeadRow[] }>("/api/sales/leads", fetcher)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all")
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LeadRow | null>(null)

  const leads = data?.leads ?? []

  const filtered = useMemo(() => {
    let rows = leads
    if (filter === "followups") rows = rows.filter((l) => l.status === "Follow Up 1" || l.status === "Follow Up 2")
    else if (filter === "won") rows = rows.filter((l) => l.status === "Won")
    else if (filter === "lost") rows = rows.filter((l) => l.status === "Lost")

    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((l) =>
        [l.contact_person, l.company_name, l.email, l.industry, l.country]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q)),
      )
    }
    return rows
  }, [leads, filter, search])

  const counts = useMemo(
    () => ({
      all: leads.length,
      followups: leads.filter((l) => l.status === "Follow Up 1" || l.status === "Follow Up 2").length,
      won: leads.filter((l) => l.status === "Won").length,
      lost: leads.filter((l) => l.status === "Lost").length,
    }),
    [leads],
  )

  async function deleteLead(lead: LeadRow) {
    if (!confirm(`Delete lead for ${lead.company_name}? This cannot be undone.`)) return
    const res = await fetch(`/api/sales/leads/${lead.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Lead deleted")
      mutate()
    } else {
      toast.error("Unable to delete lead")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "outline"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <Badge variant={filter === f.key ? "secondary" : "outline"} className="ml-1">
                {counts[f.key]}
              </Badge>
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search leads..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 pl-8"
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
              Add lead
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Follow-up</TableHead>
              <TableHead>Assigned</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading leads...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No leads match this view.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((lead) => (
              <TableRow key={lead.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{lead.contact_person || "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {lead.lead_code} · {lead.designation || "—"}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{lead.company_name || "—"}</span>
                    <span className="text-xs text-muted-foreground">{lead.industry || "—"}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{lead.lead_source || "—"}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[lead.status] || "outline"}>{lead.status}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress value={lead.lead_health_score} className="h-1.5 w-16" />
                    <span className="text-xs text-muted-foreground">{lead.lead_health_score}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lead.follow_up_date ? formatDateTime(lead.follow_up_date) : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">{lead.assigned_to_name || "Unassigned"}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(lead)
                            setDialogOpen(true)
                          }}
                        >
                          Edit lead
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteLead(lead)}>
                          Delete lead
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

      <LeadDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        lead={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Lead updated" : "Lead added")
          mutate()
        }}
      />
    </div>
  )
}
