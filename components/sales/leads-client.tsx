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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Mail, MoreHorizontal, Plus, Search } from "lucide-react"
import { LeadDialog } from "@/components/sales/lead-dialog"
import { ComposeEmailDialog } from "@/components/sales/compose-email-dialog"
import { ExcelImportButton } from "@/components/sales/excel-import-button"

const LEAD_IMPORT_ALIASES = {
  contact_person: ["contactperson", "name", "contact"],
  contact_number: ["contactnumber", "phone", "phonenumber", "mobile"],
  email: ["email", "emailaddress"],
  designation: ["designation", "title", "jobtitle"],
  lead_source: ["leadsource", "source"],
  company_name: ["companyname", "company"],
  industry: ["industry"],
  website: ["website", "url"],
  company_email: ["companyemail"],
  country: ["country"],
  status: ["status"],
  lead_date: ["leaddate", "date"],
  follow_up_date: ["followupdate", "followup"],
  remarks: ["remarks", "notes"],
} satisfies Record<string, string[]>

const LEAD_IMPORT_HEADERS = [
  "Contact Person",
  "Contact Number",
  "Email",
  "Designation",
  "Lead Source",
  "Company Name",
  "Industry",
  "Website",
  "Company Email",
  "Country",
  "Status",
  "Lead Date",
  "Follow Up Date",
  "Remarks",
]

const LEAD_IMPORT_SAMPLE = [
  "Jane Doe",
  "9876543210",
  "jane@example.com",
  "Procurement Manager",
  "LinkedIn",
  "Acme Corp",
  "Manufacturing",
  "https://acme.example.com",
  "info@acme.example.com",
  "India",
  "New",
  "2026-08-30",
  "",
  "Interested in bulk pricing",
]

export type LeadRow = {
  id: number
  lead_code: string
  lead_date: string | null
  contact_person: string | null
  contact_number: string | null
  email: string | null
  designation: string | null
  source_url: string | null
  lead_source: string | null
  company_name: string | null
  industry: string | null
  website: string | null
  company_email: string | null
  country: string | null
  assigned_to: number | null
  assigned_to_name: string | null
  status: string
  lead_status: "Open" | "Won" | "Lost" | "Follow Up"
  follow_up_date: string | null
  last_contact_date: string | null
  lead_health_score: number
  remarks: string | null
  created_at: string
}

const FILTERS = [
  { key: "all", label: "Lead" },
  { key: "followups", label: "Follow-ups" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
] as const

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  New: "outline",
  Qualified: "secondary",
  "Follow Up 1": "secondary",
  "Follow Up 2": "secondary",
  "Follow Up 3": "secondary",
  "Follow Up 4": "secondary",
  "Follow Up 5": "secondary",
  "Follow Up 6": "secondary",
  "Follow Up 7": "secondary",
  "In Discussion": "default",
  "Proposal Sent": "default",
  Ready: "default",
  Won: "default",
  Lost: "destructive",
}

const STATUS_OPTIONS = [
  "New",
  "Qualified",
  "Follow Up 1",
  "Follow Up 2",
  "Follow Up 3",
  "Follow Up 4",
  "Follow Up 5",
  "Follow Up 6",
  "Follow Up 7",
  "Proposal Sent",
] as const

const LEAD_STATUS_OPTIONS = ["Open", "Won", "Lost", "Follow Up"] as const

const LEAD_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Open: "outline",
  Won: "default",
  Lost: "destructive",
  "Follow Up": "secondary",
}

type LeadStatus = (typeof LEAD_STATUS_OPTIONS)[number]

// Derive the effective lead status. On databases where the `lead_status`
// column hasn't been populated yet (e.g. migration not run), we fall back to
// deriving it from the pipeline `status` so leads still appear in the tabs.
function effectiveLeadStatus(lead: LeadRow): LeadStatus {
  if (lead.lead_status && LEAD_STATUS_OPTIONS.includes(lead.lead_status as LeadStatus)) {
    return lead.lead_status as LeadStatus
  }
  const s = lead.status || ""
  if (s === "Won") return "Won"
  if (s === "Lost") return "Lost"
  if (s.startsWith("Follow Up")) return "Follow Up"
  return "Open"
}

export function LeadsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ leads: LeadRow[] }>("/api/sales/leads", fetcher)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all")
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LeadRow | null>(null)
  const [emailLead, setEmailLead] = useState<LeadRow | null>(null)
  const [emailOpen, setEmailOpen] = useState(false)

  const leads = data?.leads ?? []

  const filtered = useMemo(() => {
    let rows = leads
    if (filter === "all") rows = rows.filter((l) => effectiveLeadStatus(l) === "Open")
    else if (filter === "followups") rows = rows.filter((l) => effectiveLeadStatus(l) === "Follow Up")
    else if (filter === "won") rows = rows.filter((l) => effectiveLeadStatus(l) === "Won")
    else if (filter === "lost") rows = rows.filter((l) => effectiveLeadStatus(l) === "Lost")

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
      all: leads.filter((l) => effectiveLeadStatus(l) === "Open").length,
      followups: leads.filter((l) => effectiveLeadStatus(l) === "Follow Up").length,
      won: leads.filter((l) => effectiveLeadStatus(l) === "Won").length,
      lost: leads.filter((l) => effectiveLeadStatus(l) === "Lost").length,
    }),
    [leads],
  )

  async function updateLeadStatus(lead: LeadRow, nextStatus: (typeof LEAD_STATUS_OPTIONS)[number]) {
    const res = await fetch(`/api/sales/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_status: nextStatus }),
    })
    if (res.ok) {
      toast.success(`Lead marked as ${nextStatus}`)
      mutate()
    } else {
      toast.error("Unable to update lead status")
    }
  }

  async function updateStatus(lead: LeadRow, nextStatus: string) {
    const res = await fetch(`/api/sales/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    })
    if (res.ok) {
      toast.success(`Status updated to ${nextStatus}`)
      mutate()
    } else {
      toast.error("Unable to update status")
    }
  }

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
            <ExcelImportButton
              endpoint="/api/sales/leads/import"
              aliases={LEAD_IMPORT_ALIASES}
              templateFilename="leads-template.xlsx"
              templateHeaders={LEAD_IMPORT_HEADERS}
              templateSample={LEAD_IMPORT_SAMPLE}
              onImported={() => mutate()}
            />
          )}
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
              <TableHead>Lead Status</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Assigned</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  Loading leads...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
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
                    <span>{lead.company_name || "���"}</span>
                    <span className="text-xs text-muted-foreground">{lead.industry || "—"}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{lead.lead_source || "—"}</TableCell>
                <TableCell>
                  {canManage ? (
                    <Select value={lead.status ?? ""} onValueChange={(value) => updateStatus(lead, value as string)}>
                      <SelectTrigger size="sm" className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                        {!STATUS_OPTIONS.includes(lead.status as (typeof STATUS_OPTIONS)[number]) && (
                          <SelectItem value={lead.status}>{lead.status}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={STATUS_VARIANT[lead.status] || "outline"}>{lead.status}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <Select
                      value={effectiveLeadStatus(lead)}
                      onValueChange={(value) =>
                        updateLeadStatus(lead, value as (typeof LEAD_STATUS_OPTIONS)[number])
                      }
                    >
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEAD_STATUS_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={LEAD_STATUS_VARIANT[effectiveLeadStatus(lead)] || "outline"}>
                      {effectiveLeadStatus(lead)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress value={lead.lead_health_score} className="h-1.5 w-16" />
                    <span className="text-xs text-muted-foreground">{lead.lead_health_score}%</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!lead.email}
                    onClick={() => {
                      setEmailLead(lead)
                      setEmailOpen(true)
                    }}
                  >
                    <Mail data-icon="inline-start" /> Email
                  </Button>
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

      <ComposeEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        onSent={() => mutate()}
        emailConfigured={true}
        initialLead={emailLead}
      />

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
