"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Wallet,
  ReceiptText,
  FileText,
  Banknote,
  ScrollText,
  Eye,
  EyeOff,
  Send,
  CheckCircle2,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import {
  PORTAL_INVOICES,
  PORTAL_POS,
  PORTAL_PAYMENTS,
  PORTAL_CONTRACTS,
  INVOICE_STATUS_LABEL,
  formatMoney,
} from "./mock-data"

const INVOICE_COLUMNS: Column[] = [
  { key: "id", header: "Invoice" },
  { key: "vendor", header: "Vendor" },
  { key: "po", header: "PO" },
  { key: "date", header: "Date" },
  { key: "amount", header: "Amount", align: "right" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

const PO_COLUMNS: Column[] = [
  { key: "id", header: "PO Number" },
  { key: "vendor", header: "Vendor" },
  { key: "amount", header: "Amount", align: "right" },
  { key: "issued", header: "Issued" },
  { key: "status", header: "Status" },
  { key: "ack", header: "Acknowledged" },
  { key: "visible", header: "Portal" },
  { key: "actions", header: "" },
]

const PAYMENT_COLUMNS: Column[] = [
  { key: "id", header: "Reference" },
  { key: "vendor", header: "Vendor" },
  { key: "invoice", header: "Invoice" },
  { key: "amount", header: "Amount", align: "right" },
  { key: "date", header: "Date" },
  { key: "method", header: "Method" },
  { key: "status", header: "Status" },
  { key: "advice", header: "Advice" },
  { key: "visible", header: "Portal" },
]

const CONTRACT_COLUMNS: Column[] = [
  { key: "title", header: "Contract" },
  { key: "vendor", header: "Vendor" },
  { key: "effective", header: "Effective" },
  { key: "expiry", header: "Expiry" },
  { key: "status", header: "Status" },
  { key: "visible", header: "Portal" },
  { key: "actions", header: "" },
]

export function FinanceControlSection() {
  const [tab, setTab] = useState("invoices")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Finance Portal Control"
        description="Administer vendor-submitted invoices and control which purchase orders, payments and contracts are visible in the portal."
        icon={Wallet}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="invoices">
            <ReceiptText className="size-4" /> Invoices
          </TabsTrigger>
          <TabsTrigger value="pos">
            <FileText className="size-4" /> Purchase Orders
          </TabsTrigger>
          <TabsTrigger value="payments">
            <Banknote className="size-4" /> Payments
          </TabsTrigger>
          <TabsTrigger value="contracts">
            <ScrollText className="size-4" /> Contracts
          </TabsTrigger>
        </TabsList>

        {/* Invoices */}
        <TabsContent value="invoices">
          <AdminTable
            columns={INVOICE_COLUMNS}
            rows={PORTAL_INVOICES}
            empty={<EmptyState icon={ReceiptText} title="No invoices" />}
            render={(inv, key) => {
              switch (key) {
                case "id":
                  return <span className="font-mono text-xs">{inv.id}</span>
                case "vendor":
                  return <span className="font-medium">{inv.vendor}</span>
                case "po":
                  return <span className="font-mono text-xs text-muted-foreground">{inv.po}</span>
                case "date":
                  return <span className="text-muted-foreground">{inv.date}</span>
                case "amount":
                  return <span className="tabular-nums">{formatMoney(inv.amount, inv.currency)}</span>
                case "status":
                  return <StatusBadge status={inv.status} label={INVOICE_STATUS_LABEL[inv.status]} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Invoice approved")}>
                        <CheckCircle2 className="size-3.5" /> Approve
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Invoice rejected")}>
                        <XCircle className="size-3.5" /> Reject
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        {/* POs */}
        <TabsContent value="pos">
          <AdminTable
            columns={PO_COLUMNS}
            rows={PORTAL_POS}
            empty={<EmptyState icon={FileText} title="No purchase orders" />}
            render={(po, key) => {
              switch (key) {
                case "id":
                  return <span className="font-mono text-xs">{po.id}</span>
                case "vendor":
                  return <span className="font-medium">{po.vendor}</span>
                case "amount":
                  return <span className="tabular-nums">{formatMoney(po.amount, po.currency)}</span>
                case "issued":
                  return <span className="text-muted-foreground">{po.issued}</span>
                case "status":
                  return <StatusBadge status={po.status.toLowerCase()} label={po.status} />
                case "ack":
                  return po.acknowledged ? (
                    <StatusBadge tone="success" label={po.ackDate ?? "Yes"} />
                  ) : (
                    <StatusBadge tone="neutral" label="Pending" />
                  )
                case "visible":
                  return <StatusBadge tone={po.visible ? "success" : "neutral"} label={po.visible ? "Shared" : "Hidden"} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success(po.visible ? "Hidden from portal" : "Shared to portal")}>
                        {po.visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        {po.visible ? "Hide" : "Share"}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Notification resent")}>
                        <Send className="size-3.5" /> Notify
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        {/* Payments */}
        <TabsContent value="payments">
          <AdminTable
            columns={PAYMENT_COLUMNS}
            rows={PORTAL_PAYMENTS}
            empty={<EmptyState icon={Banknote} title="No payments" />}
            render={(p, key) => {
              switch (key) {
                case "id":
                  return <span className="font-mono text-xs">{p.id}</span>
                case "vendor":
                  return <span className="font-medium">{p.vendor}</span>
                case "invoice":
                  return <span className="font-mono text-xs text-muted-foreground">{p.invoice}</span>
                case "amount":
                  return <span className="tabular-nums">{formatMoney(p.amount, p.currency)}</span>
                case "date":
                  return <span className="text-muted-foreground">{p.date}</span>
                case "method":
                  return p.method
                case "status":
                  return <StatusBadge status={p.status.toLowerCase()} label={p.status} />
                case "advice":
                  return p.advice ? (
                    <Button size="xs" variant="outline" onClick={() => toast.success(p.visible ? "Advice hidden" : "Advice published")}>
                      {p.visible ? "Unpublish" : "Publish"}
                    </Button>
                  ) : (
                    <StatusBadge tone="neutral" label="None" />
                  )
                case "visible":
                  return <StatusBadge tone={p.visible ? "success" : "neutral"} label={p.visible ? "Visible" : "Hidden"} />
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        {/* Contracts */}
        <TabsContent value="contracts">
          <AdminTable
            columns={CONTRACT_COLUMNS}
            rows={PORTAL_CONTRACTS}
            empty={<EmptyState icon={ScrollText} title="No contracts" />}
            render={(c, key) => {
              switch (key) {
                case "title":
                  return <span className="font-medium">{c.title}</span>
                case "vendor":
                  return <span className="text-muted-foreground">{c.vendor}</span>
                case "effective":
                  return <span className="text-muted-foreground">{c.effective}</span>
                case "expiry":
                  return <span className="text-muted-foreground">{c.expiry}</span>
                case "status":
                  return <StatusBadge tone={c.status === "Active" ? "success" : "warning"} label={c.status} />
                case "visible":
                  return (
                    <div className="flex items-center gap-2">
                      <Switch checked={c.visible} onCheckedChange={() => toast.success(c.visible ? "Unshared" : "Shared")} />
                      <span className="text-xs text-muted-foreground">{c.visible ? "Shared" : "Hidden"}</span>
                    </div>
                  )
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Acceptance requested")}>
                        Request Acceptance
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
