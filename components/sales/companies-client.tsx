"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
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
import { ArrowUpRight, MoreHorizontal, Plus, Search } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { CompanyDialog } from "@/components/sales/company-dialog"
import { ExcelImportButton } from "@/components/sales/excel-import-button"
import { ExcelExportButton } from "@/components/excel-export-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

const COMPANY_IMPORT_ALIASES = {
  company_name: ["companyname", "company", "name"],
  industry: ["industry"],
  website: ["website", "url"],
  linkedin_url: ["linkedinurl", "linkedin"],
  company_email: ["companyemail", "email"],
  country: ["country"],
  company_type: ["companytype", "type"],
  status: ["status"],
  priority: ["priority"],
  founded_year: ["foundedyear", "founded"],
  employee_count: ["employeecount", "employees"],
} satisfies Record<string, string[]>

const COMPANY_IMPORT_HEADERS = [
  "Company Name",
  "Industry",
  "Website",
  "LinkedIn URL",
  "Company Email",
  "Country",
  "Company Type",
  "Status",
  "Priority",
  "Founded Year",
  "Employee Count",
]

const COMPANY_IMPORT_SAMPLE = [
  "Acme Corp",
  "Manufacturing",
  "https://acme.example.com",
  "https://linkedin.com/company/acme",
  "info@acme.example.com",
  "India",
  "Client",
  "New",
  "High",
  "2010",
  "250",
]

export type CompanyRow = {
  id: number
  company_code: string
  company_date: string | null
  company_name: string
  industry: string | null
  website: string | null
  linkedin_url: string | null
  company_email: string | null
  country: string | null
  assigned_to: number | null
  assigned_to_name: string | null
  company_type: string | null
  status: string
  priority: string | null
  founded_year: number | null
  employee_count: number | null
  last_contact_date: string | null
  lead_count: number | null
  archived_at: string | null
  created_at: string
}

type SortKey = "recent" | "oldest" | "name_asc" | "name_desc" | "leads"

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
  { value: "leads", label: "Most leads" },
]

const ALL = "__all__"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  New: "outline",
  Contacted: "secondary",
  Qualified: "default",
  Inactive: "destructive",
}

const PRIORITY_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  High: "default",
  Medium: "secondary",
  Low: "outline",
}

const STATUS_OPTIONS = ["New", "Contacted", "Qualified", "Inactive"] as const

const PRIORITY_OPTIONS = ["High", "Medium", "Low"] as const

export function CompaniesClient({ canManage }: { canManage: boolean }) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [priorityFilter, setPriorityFilter] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)
  const [ownerFilter, setOwnerFilter] = useState<string>(ALL)
  const [sort, setSort] = useState<SortKey>("recent")
  const [showArchived, setShowArchived] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CompanyRow | null>(null)

  const { data, isLoading, mutate } = useSWR<{ companies: CompanyRow[] }>(
    `/api/sales/companies${showArchived ? "?archived=1" : ""}`,
    fetcher,
  )

  const companies = data?.companies ?? []

  const typeOptions = useMemo(
    () => Array.from(new Set(companies.map((c) => c.company_type).filter(Boolean) as string[])).sort(),
    [companies],
  )
  const ownerOptions = useMemo(
    () => Array.from(new Set(companies.map((c) => c.assigned_to_name).filter(Boolean) as string[])).sort(),
    [companies],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = companies.filter((c) => {
      if (statusFilter !== ALL && c.status !== statusFilter) return false
      if (priorityFilter !== ALL && (c.priority || "") !== priorityFilter) return false
      if (typeFilter !== ALL && (c.company_type || "") !== typeFilter) return false
      if (ownerFilter !== ALL) {
        if (ownerFilter === "__unassigned__" ? c.assigned_to_name : c.assigned_to_name !== ownerFilter) return false
      }
      if (q) {
        return [c.company_name, c.company_code, c.industry, c.country, c.company_type]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q))
      }
      return true
    })

    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return a.created_at.localeCompare(b.created_at)
        case "name_asc":
          return a.company_name.localeCompare(b.company_name)
        case "name_desc":
          return b.company_name.localeCompare(a.company_name)
        case "leads":
          return (b.lead_count || 0) - (a.lead_count || 0)
        default:
          return b.created_at.localeCompare(a.created_at)
      }
    })
    return rows
  }, [companies, search, statusFilter, priorityFilter, typeFilter, ownerFilter, sort])

  const activeFilterCount =
    (statusFilter !== ALL ? 1 : 0) +
    (priorityFilter !== ALL ? 1 : 0) +
    (typeFilter !== ALL ? 1 : 0) +
    (ownerFilter !== ALL ? 1 : 0)

  function resetFilters() {
    setStatusFilter(ALL)
    setPriorityFilter(ALL)
    setTypeFilter(ALL)
    setOwnerFilter(ALL)
  }

  async function updateField(company: CompanyRow, field: "status" | "priority", value: string) {
    const res = await fetch(`/api/sales/companies/${company.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    })
    if (res.ok) {
      toast.success(`${field === "status" ? "Status" : "Priority"} updated to ${value}`)
      mutate()
    } else {
      toast.error(`Unable to update ${field}`)
    }
  }

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/companies/${id}`,
    labels: { singular: "company", plural: "companies" },
    mutate,
    onDeleted: clear,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search companies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <ExcelExportButton
            rows={filtered}
            filename="companies"
            columns={[
              { header: "Company Code", value: (r) => r.company_code },
              { header: "Company Name", value: (r) => r.company_name },
              { header: "Industry", value: (r) => r.industry },
              { header: "Website", value: (r) => r.website },
              { header: "LinkedIn", value: (r) => r.linkedin_url },
              { header: "Company Email", value: (r) => r.company_email },
              { header: "Country", value: (r) => r.country },
              { header: "Type", value: (r) => r.company_type },
              { header: "Status", value: (r) => r.status },
              { header: "Priority", value: (r) => r.priority },
              { header: "Founded Year", value: (r) => r.founded_year },
              { header: "Employee Count", value: (r) => r.employee_count },
              { header: "Assigned To", value: (r) => r.assigned_to_name },
            ]}
          />
          {canManage && (
            <>
              <ExcelImportButton
                endpoint="/api/sales/companies/import"
                aliases={COMPANY_IMPORT_ALIASES}
                templateFilename="companies-template.xlsx"
                templateHeaders={COMPANY_IMPORT_HEADERS}
                templateSample={COMPANY_IMPORT_SAMPLE}
                onImported={() => mutate()}
              />
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus data-icon="inline-start" />
                Add company
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
        />
        <FilterSelect
          label="Priority"
          value={priorityFilter}
          onChange={setPriorityFilter}
          options={PRIORITY_OPTIONS.map((p) => ({ value: p, label: p }))}
        />
        {typeOptions.length > 0 && (
          <FilterSelect
            label="Type"
            value={typeFilter}
            onChange={setTypeFilter}
            options={typeOptions.map((t) => ({ value: t, label: t }))}
          />
        )}
        <FilterSelect
          label="Owner"
          value={ownerFilter}
          onChange={setOwnerFilter}
          options={[
            { value: "__unassigned__", label: "Unassigned" },
            ...ownerOptions.map((o) => ({ value: o, label: o })),
          ]}
        />

        <div className="ml-auto flex items-center gap-2">
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          )}
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        <div className="flex items-center gap-2 pl-1">
          <Checkbox
            id="show-archived"
            checked={showArchived}
            onCheckedChange={(checked) => setShowArchived(checked === true)}
          />
            <Label htmlFor="show-archived" className="text-sm text-muted-foreground">
              Archived
            </Label>
          </div>
        </div>
      </div>

      {canManage && (
        <SelectionToolbar
          count={selected.size}
          noun="company"
          onClear={clear}
          onDelete={() => del.requestBulk([...selected])}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <SelectAllCheckbox ids={filtered.map((c) => c.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Company</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-center">Leads</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead className="w-10 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={canManage ? 10 : 9} className="py-10 text-center text-sm text-muted-foreground">
                  Loading companies...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 10 : 9} className="py-10 text-center text-sm text-muted-foreground">
                  No companies found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((company) => (
              <TableRow key={company.id} data-state={selected.has(company.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select company ${company.company_name}`}
                      checked={selected.has(company.id)}
                      onCheckedChange={() => toggle(company.id)}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex flex-col">
                    <Link
                      href={`/modules/sales/companies/${company.id}`}
                      className="font-medium hover:underline"
                    >
                      {company.company_name}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {company.company_code}
                      {company.archived_at ? " · Archived" : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{company.industry || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{company.country || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{company.company_type || "—"}</TableCell>
                <TableCell className="text-center">
                  {company.lead_count ? (
                    <Badge variant="outline">{company.lead_count}</Badge>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <Select value={company.status ?? ""} onValueChange={(value) => updateField(company, "status", value as string)}>
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                        {!STATUS_OPTIONS.includes(company.status as (typeof STATUS_OPTIONS)[number]) &&
                          company.status && (
                            <SelectItem value={company.status}>{company.status}</SelectItem>
                          )}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={STATUS_VARIANT[company.status] || "outline"}>{company.status}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <Select
                      value={company.priority || ""}
                      onValueChange={(value) => updateField(company, "priority", value as string)}
                    >
                      <SelectTrigger size="sm" className="w-28">
                        <SelectValue placeholder="Set" />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITY_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : company.priority ? (
                    <Badge variant={PRIORITY_VARIANT[company.priority] || "outline"}>{company.priority}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{company.assigned_to_name || "Unassigned"}</TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => router.push(`/modules/sales/companies/${company.id}`)}>
                        <ArrowUpRight data-icon="inline-start" />
                        View 360
                      </DropdownMenuItem>
                      {canManage && (
                        <>
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(company)
                              setDialogOpen(true)
                            }}
                          >
                            Edit company
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => del.requestSingle(company.id, company.company_name)}
                          >
                            Delete company
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <CompanyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        company={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Company updated" : "Company added")
          mutate()
        }}
      />

      {del.dialog}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? ALL)}>
      <SelectTrigger size="sm" className="w-auto min-w-32">
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
