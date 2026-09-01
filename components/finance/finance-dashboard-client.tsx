"use client"

import useSWR from "swr"
import { useState } from "react"
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
} from "lucide-react"

const currency = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0)

const RECON_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Reconciled: "default",
  Unreconciled: "secondary",
  Exception: "destructive",
}

const modules = [
  ["sales-invoices", "Sales Invoices"], ["purchase-bills", "Purchase Bills"], ["expenses", "Expenses"],
  ["fte-invoices", "FTE Invoices"], ["freelance-invoices", "Freelance Invoices"], ["bank-transactions", "Bank Transactions"],
  ["bank-cash", "Bank & Cash"], ["chart-of-accounts", "Chart of Accounts"], ["customers-vendors", "Customer / Vendor"],
] as const

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

export function FinanceDashboardClient() {
  const [module, setModule] = useState<string>("sales-invoices")
  const [form, setForm] = useState(emptyForm)
  const { data, mutate } = useSWR(`/api/finance/records?module=${module}`, fetcher)

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

  return (
    <main className="space-y-8 p-6">
      <div>
        <p className="text-sm text-muted-foreground">Finance management</p>
        <h1 className="text-3xl font-semibold tracking-tight">Finance Dashboard</h1>
      </div>

      <FinanceOverview />

      <div className="flex flex-wrap gap-2">
        {modules.map(([key, label]) => (
          <Button key={key} variant={module === key ? "default" : "outline"} onClick={() => setModule(key)}>
            {label}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add {modules.find(([key]) => key === module)?.[1]}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="grid gap-3 md:grid-cols-4">
            {Object.entries(form)
              .filter(([key]) => key !== "reconciliation_status" || isBankTransactions)
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
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{modules.find(([key]) => key === module)?.[1]} records</CardTitle>
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
      </Card>
    </main>
  )
}
