"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { toast } from "sonner"
import { Wallet } from "lucide-react"
import {
  SectionHeader,
  SearchInput,
  StatusBadge,
  RowActions,
  Panel,
  KpiCard,
  EmptyState,
  fmtDate,
  fmtMoney,
} from "@/components/vendor-portal-admin/shared"
import {
  PORTAL_INVOICES,
  PORTAL_POS,
  PORTAL_PAYMENTS,
  PORTAL_CONTRACTS,
} from "@/lib/vendor-portal/admin-data"

export function FinanceControlSection() {
  const [tab, setTab] = useState("invoices")
  const [query, setQuery] = useState("")

  const totals = useMemo(() => {
    const submitted = PORTAL_INVOICES.filter((i) => i.status === "submitted" || i.status === "under-review").length
    const disputed = PORTAL_INVOICES.filter((i) => i.status === "disputed").length
    const openPO = PORTAL_POS.filter((p) => p.status !== "closed").length
    const paid = PORTAL_PAYMENTS.reduce((s, p) => (p.status === "paid" ? s + p.amount : s), 0)
    return { submitted, disputed, openPO, paid }
  }, [])

  const q = query.toLowerCase()
  const invoices = PORTAL_INVOICES.filter((i) => !q || i.id.toLowerCase().includes(q) || i.vendor.toLowerCase().includes(q))
  const pos = PORTAL_POS.filter((p) => !q || p.id.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q))
  const payments = PORTAL_PAYMENTS.filter((p) => !q || p.id.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q))
  const contracts = PORTAL_CONTRACTS.filter((c) => !q || c.id.toLowerCase().includes(q) || c.vendor.toLowerCase().includes(q))

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Finance Control"
        description="Oversee invoices submitted through the portal, shared purchase orders, payment status and vendor contracts."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Invoices to review" value={totals.submitted} tone="warning" />
        <KpiCard label="Disputed" value={totals.disputed} tone="danger" />
        <KpiCard label="Open POs" value={totals.openPO} />
        <KpiCard label="Paid (visible)" value={fmtMoney(totals.paid)} tone="success" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="pos">Purchase Orders</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
          </TabsList>
          <SearchInput value={query} onChange={setQuery} placeholder="Search…" className="w-full sm:ml-auto sm:w-64" />
        </div>

        <TabsContent value="invoices" className="pt-4">
          <Panel>
            {invoices.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>PO ref</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.id}</TableCell>
                      <TableCell className="text-muted-foreground">{i.vendor}</TableCell>
                      <TableCell className="font-mono text-xs">{i.poRef ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(i.amount, i.currency)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(i.submitted)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(i.due)}</TableCell>
                      <TableCell>
                        <StatusBadge status={i.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions
                          label="Invoice"
                          actions={[
                            { label: "View invoice" },
                            { label: "Approve", onSelect: () => toast.success(`${i.id} approved`) },
                            { label: "Send to AP" },
                            { label: "Dispute", destructive: true, separatorBefore: true },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<Wallet className="size-8" />} title="No invoices" />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="pos" className="pt-4">
          <Panel>
            {pos.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Billed %</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pos.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.id}</TableCell>
                      <TableCell className="text-muted-foreground">{p.vendor}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.billedPct}%</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(p.issued)}</TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions
                          label="PO"
                          actions={[
                            { label: "View PO" },
                            { label: "Share with vendor", onSelect: () => toast.success("Shared to portal") },
                            { label: "Close PO", destructive: true, separatorBefore: true },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<Wallet className="size-8" />} title="No purchase orders" />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="payments" className="pt-4">
          <Panel>
            {payments.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payment</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Invoice ref</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.id}</TableCell>
                      <TableCell className="text-muted-foreground">{p.vendor}</TableCell>
                      <TableCell className="font-mono text-xs">{p.invoiceRef}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</TableCell>
                      <TableCell className="text-muted-foreground">{p.method}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(p.date)}</TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<Wallet className="size-8" />} title="No payments" />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="contracts" className="pt-4">
          <Panel>
            {contracts.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Ends</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contracts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.id}</TableCell>
                      <TableCell className="text-muted-foreground">{c.vendor}</TableCell>
                      <TableCell>{c.title}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(c.value, c.currency)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(c.end)}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions
                          label="Contract"
                          actions={[
                            { label: "View contract" },
                            { label: "Renew", onSelect: () => toast.success("Renewal drafted") },
                            { label: "Terminate", destructive: true, separatorBefore: true },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<Wallet className="size-8" />} title="No contracts" />
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}
