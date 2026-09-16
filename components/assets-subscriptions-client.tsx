"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Download, Laptop, Plus, Search, Upload, CreditCard } from "lucide-react"

type Variant = "employee-assets" | "company-subscriptions"

type Field = { name: string; type?: "text" | "date" | "number" | "textarea"; options?: string[] }
type Column = { key: string; label: string; align?: "left" | "right" }
type Filter = { label: string; options: string[] }

type BadgeVariant = "default" | "secondary" | "outline" | "destructive"

type VariantConfig = {
  icon: typeof Laptop
  breadcrumb: string
  addLabel: string
  formTitle: string
  filters: Filter[]
  fields: Field[]
  columns: Column[]
  statusKey: string
  statusColors: Record<string, BadgeVariant>
  rows: Record<string, string>[]
}

const CONFIGS: Record<Variant, VariantConfig> = {
  "employee-assets": {
    icon: Laptop,
    breadcrumb: "Assets & Subscriptions",
    addLabel: "Add New Asset",
    formTitle: "Add Asset Info",
    filters: [
      { label: "Asset Type", options: ["All", "Hardware", "Software", "Accessory", "Furniture"] },
      { label: "Status", options: ["All", "Available", "Assigned", "Under Maintenance", "Damaged", "Lost"] },
    ],
    fields: [
      { name: "Asset name" },
      { name: "Asset type", options: ["Hardware", "Software", "Accessory", "Furniture"] },
      { name: "Serial number" },
      { name: "Value", type: "number" },
      { name: "Assigned to" },
      { name: "Assigned date", type: "date" },
      { name: "Location" },
      { name: "Status", options: ["Available", "Assigned", "Under Maintenance", "Damaged", "Lost"] },
      { name: "Description", type: "textarea" },
    ],
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Asset" },
      { key: "type", label: "Type" },
      { key: "serial", label: "Serial no." },
      { key: "assignedTo", label: "Assigned to" },
      { key: "date", label: "Assigned on" },
      { key: "status", label: "Status" },
    ],
    statusKey: "status",
    statusColors: { Available: "secondary", Assigned: "default", "Under Maintenance": "outline", Damaged: "destructive", Lost: "destructive" },
    rows: [
      { id: "AST-001", name: 'MacBook Pro 14"', type: "Hardware", serial: "C02X1234JGH7", assignedTo: "Ashutosh Garg", date: "12-08-2026", status: "Assigned" },
      { id: "AST-002", name: "Dell UltraSharp Monitor", type: "Hardware", serial: "CN0MON5521", assignedTo: "Priya Sharma", date: "03-07-2026", status: "Assigned" },
      { id: "AST-003", name: "Logitech MX Keyboard", type: "Accessory", serial: "LGT-MX-8890", assignedTo: "—", date: "—", status: "Available" },
      { id: "AST-004", name: "Adobe Creative Cloud Seat", type: "Software", serial: "ADB-CC-4471", assignedTo: "Rahul Verma", date: "21-06-2026", status: "Assigned" },
      { id: "AST-005", name: "iPhone 15", type: "Hardware", serial: "F17XYZ99KLM", assignedTo: "—", date: "—", status: "Under Maintenance" },
    ],
  },
  "company-subscriptions": {
    icon: CreditCard,
    breadcrumb: "Assets & Subscriptions",
    addLabel: "Add New Subscription",
    formTitle: "Add Subscription Info",
    filters: [
      { label: "Billing", options: ["All", "Monthly", "Quarterly", "Annual"] },
      { label: "Status", options: ["All", "Active", "Trial", "Expiring Soon", "Cancelled"] },
    ],
    fields: [
      { name: "Subscription name" },
      { name: "Vendor" },
      { name: "Plan" },
      { name: "Billing cycle", options: ["Monthly", "Quarterly", "Annual"] },
      { name: "Amount", type: "number" },
      { name: "Seats", type: "number" },
      { name: "Renewal date", type: "date" },
      { name: "Owner" },
      { name: "Status", options: ["Active", "Trial", "Expiring Soon", "Cancelled"] },
      { name: "Notes", type: "textarea" },
    ],
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Subscription" },
      { key: "vendor", label: "Vendor" },
      { key: "plan", label: "Plan" },
      { key: "billing", label: "Billing" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "renewal", label: "Renewal" },
      { key: "status", label: "Status" },
    ],
    statusKey: "status",
    statusColors: { Active: "default", Trial: "secondary", "Expiring Soon": "outline", Cancelled: "destructive" },
    rows: [
      { id: "SUB-001", name: "Google Workspace", vendor: "Google", plan: "Business Standard", billing: "Annual", amount: "₹8,40,000", renewal: "01-04-2027", status: "Active" },
      { id: "SUB-002", name: "Slack", vendor: "Salesforce", plan: "Pro", billing: "Monthly", amount: "₹42,000", renewal: "16-10-2026", status: "Active" },
      { id: "SUB-003", name: "Adobe Creative Cloud", vendor: "Adobe", plan: "Teams (10 seats)", billing: "Annual", amount: "₹6,20,000", renewal: "28-09-2026", status: "Expiring Soon" },
      { id: "SUB-004", name: "Zoom", vendor: "Zoom", plan: "Business", billing: "Quarterly", amount: "₹55,000", renewal: "05-12-2026", status: "Active" },
      { id: "SUB-005", name: "Notion", vendor: "Notion Labs", plan: "Plus", billing: "Monthly", amount: "₹18,500", renewal: "16-10-2026", status: "Trial" },
    ],
  },
}

function AddForm({ config, onClose }: { config: VariantConfig; onClose: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{config.formTitle}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        {config.fields.map((field) => (
          <label key={field.name} className={`grid gap-2 text-sm font-medium ${field.type === "textarea" ? "sm:col-span-2" : ""}`}>
            {field.name}
            {field.options ? (
              <select aria-label={field.name} className="h-9 rounded-md border bg-background px-2 text-sm font-normal">
                {field.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea aria-label={field.name} rows={3} className="rounded-md border bg-background p-2 text-sm font-normal" placeholder={`Enter ${field.name.toLowerCase()}`} />
            ) : (
              <Input type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"} placeholder={field.name} />
            )}
          </label>
        ))}
        <label className="sm:col-span-2 grid gap-2 text-sm font-medium">
          Attachment
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <Upload className="size-5" /> Choose a file
          </div>
        </label>
        <div className="sm:col-span-2 flex gap-3 border-t pt-5">
          <Button>Save</Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function AssetsSubscriptionsClient({ variant, name, description }: { variant: Variant; name: string; description: string }) {
  const config = CONFIGS[variant]
  const Icon = config.icon
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showForm, setShowForm] = useState(false)

  const rows = useMemo(() => {
    return config.rows.filter((row) => {
      const matchesQuery = query.trim() === "" || Object.values(row).some((v) => v.toLowerCase().includes(query.toLowerCase()))
      const matchesFilters = config.filters.every((f) => {
        const active = filters[f.label]
        if (!active || active === "All") return true
        return Object.values(row).includes(active)
      })
      return matchesQuery && matchesFilters
    })
  }, [config, query, filters])

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <nav className="text-sm text-muted-foreground">
          <Link href="/modules/assets" className="hover:text-foreground">
            {config.breadcrumb}
          </Link>{" "}
          • {name}
        </nav>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
        {config.filters.map((f) => (
          <div key={f.label} className="flex items-center gap-2">
            <span className="text-muted-foreground">{f.label}</span>
            <select
              aria-label={f.label}
              className="h-9 rounded-md border bg-background px-2"
              value={filters[f.label] ?? "All"}
              onChange={(e) => setFilters((prev) => ({ ...prev, [f.label]: e.target.value }))}
            >
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="relative ml-auto min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing to search" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="mr-2 size-4" />
          {config.addLabel}
        </Button>
        <Button variant="outline">
          <Download className="mr-2 size-4" />
          Export
        </Button>
      </div>

      {showForm && <AddForm config={config} onClose={() => setShowForm(false)} />}

      <Card>
        <CardHeader>
          <CardTitle>{name}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                {config.columns.map((c) => (
                  <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    {config.columns.map((c) => (
                      <TableCell key={c.key} className={c.align === "right" ? "text-right tabular-nums" : undefined}>
                        {c.key === config.statusKey ? (
                          <Badge variant={config.statusColors[row[c.key]] ?? "outline"}>{row[c.key]}</Badge>
                        ) : c.key === "id" ? (
                          <span className="font-mono text-xs text-muted-foreground">{row[c.key]}</span>
                        ) : (
                          row[c.key]
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={config.columns.length}>
                    <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                      <Icon className="size-9" />
                      <p>{query ? `No records match "${query}".` : "No record found."}</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  )
}
