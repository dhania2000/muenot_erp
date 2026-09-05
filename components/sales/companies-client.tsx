"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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
import { MoreHorizontal, Plus, Search } from "lucide-react"
import { CompanyDialog } from "@/components/sales/company-dialog"
import { ExcelImportButton } from "@/components/sales/excel-import-button"

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
  created_at: string
}

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
  const { data, isLoading, mutate } = useSWR<{ companies: CompanyRow[] }>("/api/sales/companies", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CompanyRow | null>(null)

  const companies = data?.companies ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return companies
    return companies.filter((c) =>
      [c.company_name, c.industry, c.country, c.company_type].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
    )
  }, [companies, search])

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

  async function deleteCompany(company: CompanyRow) {
    if (!confirm(`Delete ${company.company_name}? This cannot be undone.`)) return
    const res = await fetch(`/api/sales/companies/${company.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Company deleted")
      mutate()
    } else {
      toast.error("Unable to delete company")
    }
  }

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
        {canManage && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assigned</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading companies...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No companies found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((company) => (
              <TableRow key={company.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{company.company_name}</span>
                    <span className="text-xs text-muted-foreground">{company.company_code}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{company.industry || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{company.country || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{company.company_type || "—"}</TableCell>
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
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(company)
                            setDialogOpen(true)
                          }}
                        >
                          Edit company
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteCompany(company)}>
                          Delete company
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
    </div>
  )
}
