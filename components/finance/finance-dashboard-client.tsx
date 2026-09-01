"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  Wallet,
  Receipt,
  CreditCard,
  TrendingDown,
  Landmark,
  ArrowLeftRight,
  FilterX,
} from "lucide-react"
import { FINANCE_MODULES } from "@/lib/finance-modules"
import { ExcelImportButton } from "@/components/sales/excel-import-button"

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const FINANCE_IMPORT_ALIASES: Record<string, string[]> = {
  record_date: ["date", "recorddate", "transactiondate", "invoicedate", "billdate", "entrydate"],
  party_name: ["party", "partyname", "customer", "customername", "vendor", "vendorname", "clientname"],
  account_name: ["account", "accountname", "bankaccount", "ledgeraccount"],
  record_type: ["type", "recordtype", "category"],
  amount: ["amount", "totalamount", "invoiceamount", "billamount"],
  debit: ["debit", "debitamount", "dr"],
  credit: ["credit", "creditamount", "cr"],
  status: ["status", "recordstatus"],
  reconciliation_status: ["reconciliationstatus", "reconciliation", "reconstatus"],
  description: ["description", "notes", "remarks", "narration"],
}

const currency = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0)

const RECON_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Reconciled: "default",
  Unreconciled: "secondary",
  Exception: "destructive",
}

const modules = Object.entries(FINANCE_MODULES).map(([key, v]) => [key, v.label] as const)

const emptyForm = {
  reference_no: "", record_date: "", party_name: "", account_name: "", record_type: "",
  amount: "", debit: "", credit: "", status: "Draft", reconciliation_status: "", description: "",
}

function FinanceOverview() {
  const { data, isLoading } = useSWR("/api/finance/dashboard", fetcher, { refreshInterval: 30000 })

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading finance dashboard...</div>
  }

  const { kpis, invoiceStatus, bankReconciliation, financeMasterModules, masterRecordSummary, recentTransactions } = data

  const kpiCards = [
    { label: "Sales Billing", value: currency(kpis.salesBilling), icon: Receipt },
    { label: "Receivables", value: currency(kpis.receivables), icon: Wallet },
    { label: "Payables", value: currency(kpis.payables), icon: CreditCard },
    { label: "Expenses", value: currency(kpis.expenses), icon: TrendingDown },
    { label: "Bank Balance", value: currency(kpis.bankBalance), icon: Landmark },
    { label: "Net Cash Flow", value: currency(kpis.netCashFlow), icon: ArrowLeftRight },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invoice Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoiceStatus.map((row: any) => (
                  <TableRow key={row.status}>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>{row.count}</TableCell>
                    <TableCell>{currency(row.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bank Reconciliation</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bankReconciliation.map((row: any) => (
                  <TableRow key={row.status}>
                    <TableCell>
                      <Badge variant={RECON_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>{row.count}</TableCell>
                    <TableCell>{currency(row.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Finance Master Modules</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {financeMasterModules.map((row: any) => (
                  <TableRow key={row.key}>
                    <TableCell>{row.module}</TableCell>
                    <TableCell>{row.records}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Master Record Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Master</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {masterRecordSummary.map((row: any) => (
                  <TableRow key={row.master}>
                    <TableCell>{row.master}</TableCell>
                    <TableCell>{row.records}</TableCell>
                    <TableCell className="text-muted-foreground">{row.type}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Bank Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction ID</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Debit</TableHead>
                <TableHead>Credit</TableHead>
                <TableHead>Reconciliation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentTransactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No bank transactions yet.
                  </TableCell>
                </TableRow>
              )}
              {recentTransactions.map((row: any) => (
                <TableRow key={row.record_id}>
                  <TableCell className="font-mono text-xs">TXN-{String(row.record_id).padStart(6, "0")}</TableCell>
                  <TableCell>{row.record_date || "—"}</TableCell>
                  <TableCell>{row.account_name || "—"}</TableCell>
                  <TableCell>{row.party_name || "—"}</TableCell>
                  <TableCell>{row.record_type || "—"}</TableCell>
                  <TableCell>{currency(row.debit)}</TableCell>
                  <TableCell>{currency(row.credit)}</TableCell>
                  <TableCell>
                    {row.reconciliation_status ? (
                      <Badge variant={RECON_VARIANT[row.reconciliation_status] ?? "outline"}>
                        {row.reconciliation_status}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

const emptyFilters = {
  date_from: "", date_to: "", year: "", month: "", status: "", reconciliation_status: "", record_type: "", search: "",
}

export function FinanceDashboardClient({ initialModule = "overview" }: { initialModule?: string }) {
  const [module, setModule] = useState<string>(initialModule)
  const [form, setForm] = useState(emptyForm)
  const [filters, setFilters] = useState(emptyFilters)

  const queryKey = useMemo(() => {
    if (module === "overview") return null
    const params = new URLSearchParams({ module })
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v)
    }
    return `/api/finance/records?${params.toString()}`
  }, [module, filters])

  const { data, mutate } = useSWR(queryKey, fetcher)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    await fetch("/api/finance/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, module_key: module }),
    })
    setForm(emptyForm)
    mutate()
  }

  const isBankTransactions = module === "bank-transactions"

  const moduleLabel = modules.find(([key]) => key === module)?.[1]

  const filterOptions = data?.filterOptions ?? { years: [], statuses: [], types: [] }
  const activeFilterCount = Object.values(filters).filter(Boolean).length
  const templateHeaders = [
    "Record Date", "Party Name", "Account Name", "Record Type", "Amount", "Debit", "Credit", "Status",
    ...(isBankTransactions ? ["Reconciliation Status"] : []),
    "Description",
  ]

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Finance management</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {module === "overview" ? "Finance Dashboard" : moduleLabel}
          </h1>
        </div>
        {module !== "overview" && (
          <ExcelImportButton
            endpoint={`/api/finance/records/import?module=${module}`}
            aliases={FINANCE_IMPORT_ALIASES}
            templateFilename={`${module}-template.xlsx`}
            templateHeaders={templateHeaders}
            onImported={() => mutate()}
          />
        )}
      </div>

      {module === "overview" && <FinanceOverview />}

      {module !== "overview" && <Card>
        <CardHeader>
          <CardTitle>Add {modules.find(([key]) => key === module)?.[1]}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="grid gap-3 md:grid-cols-4">
            {Object.entries(form)
              .filter(([key]) => (key !== "reconciliation_status" || isBankTransactions) && key !== "reference_no")
              .map(([key, value]) => (
                <Input
                  key={key}
                  placeholder={key.replaceAll("_", " ")}
                  type={key === "record_date" ? "date" : key === "amount" || key === "debit" || key === "credit" ? "number" : "text"}
                  value={value}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                />
              ))}
            <Button type="submit">Save record</Button>
          </form>
        </CardContent>
      </Card>}

      {module !== "overview" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Filters</CardTitle>
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setFilters(emptyFilters)}>
                <FilterX data-icon="inline-start" />
                Clear filters ({activeFilterCount})
              </Button>
            )}
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              placeholder="Search reference, party, type..."
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              className="lg:col-span-2"
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Filter by year"
              value={filters.year}
              onChange={(e) => setFilters((f) => ({ ...f, year: e.target.value }))}
            >
              <option value="">All years</option>
              {filterOptions.years.map((y: number) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Filter by month"
              value={filters.month}
              onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
            >
              <option value="">All months</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                aria-label="From date"
                value={filters.date_from}
                onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                aria-label="To date"
                value={filters.date_to}
                onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))}
              />
            </div>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Filter by status"
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="">All statuses</option>
              {filterOptions.statuses.map((s: string) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {filterOptions.types.length > 0 && (
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                aria-label="Filter by type"
                value={filters.record_type}
                onChange={(e) => setFilters((f) => ({ ...f, record_type: e.target.value }))}
              >
                <option value="">All types</option>
                {filterOptions.types.map((t: string) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
            {isBankTransactions && (
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                aria-label="Filter by reconciliation status"
                value={filters.reconciliation_status}
                onChange={(e) => setFilters((f) => ({ ...f, reconciliation_status: e.target.value }))}
              >
                <option value="">All reconciliation statuses</option>
                <option value="Reconciled">Reconciled</option>
                <option value="Unreconciled">Unreconciled</option>
                <option value="Exception">Exception</option>
              </select>
            )}
          </CardContent>
        </Card>
      )}

      {module !== "overview" && <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{modules.find(([key]) => key === module)?.[1]} records</CardTitle>
          <Badge variant="secondary">{(data?.rows ?? []).length} records</Badge>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Reference</th>
                  <th className="p-2">Date</th>
                  <th className="p-2">Party</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Amount</th>
                  <th className="p-2">Status</th>
                  {isBankTransactions && <th className="p-2">Reconciliation</th>}
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={isBankTransactions ? 7 : 6} className="p-6 text-center text-muted-foreground">
                      No records match the current filters.
                    </td>
                  </tr>
                )}
                {(data?.rows ?? []).map((row: any) => (
                  <tr key={row.record_id} className="border-b">
                    <td className="p-2">{row.reference_no || "—"}</td>
                    <td className="p-2">{row.record_date || "—"}</td>
                    <td className="p-2">{row.party_name || row.account_name || "—"}</td>
                    <td className="p-2">{row.record_type || "—"}</td>
                    <td className="p-2">₹{Number(row.amount || row.debit || row.credit || 0).toLocaleString()}</td>
                    <td className="p-2">{row.status}</td>
                    {isBankTransactions && <td className="p-2">{row.reconciliation_status || "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>}
    </main>
  )
}
