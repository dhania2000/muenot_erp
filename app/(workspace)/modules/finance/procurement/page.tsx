import Link from "next/link"
import {
  ShoppingCart,
  FileText,
  ClipboardList,
  PackageCheck,
  ScrollText,
  ReceiptText,
  ArrowRight,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getTenantId } from "@/lib/api-auth"
import { getSession } from "@/lib/auth"
import { getProcurementChain, getPendingProcurementApprovals } from "@/lib/finance-procurement"

export const dynamic = "force-dynamic"

function inr(value: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(
    Number.isFinite(value) ? value : 0,
  )
}

const STAGES = [
  { href: "/modules/finance/purchase-requisition", title: "Requisitions", icon: FileText, blurb: "Raise and approve internal purchase requests." },
  { href: "/modules/finance/rfq", title: "RFQs", icon: ClipboardList, blurb: "Collect competing vendor quotes and award." },
  { href: "/modules/finance/purchase-orders", title: "Purchase Orders", icon: ScrollText, blurb: "Commit approved orders to the awarded vendor." },
  { href: "/modules/finance/goods-receipt", title: "Goods Receipt", icon: PackageCheck, blurb: "Receive, inspect and value delivered goods." },
  { href: "/modules/finance/purchase-bills", title: "Vendor Bills", icon: ReceiptText, blurb: "Book and pay vendor invoices against the chain." },
] as const

function approvalBadge(status: string) {
  const variant = status === "Approved" ? "default" : status === "Rejected" ? "destructive" : "secondary"
  return <Badge variant={variant}>{status || "Draft"}</Badge>
}

export default async function ProcurementPage() {
  const tenantId = await getTenantId()
  const session = await getSession()

  if (tenantId == null) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Procurement Management</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in to a workspace to view procurement activity.</p>
      </div>
    )
  }

  const [chain, pending] = await Promise.all([
    getProcurementChain(tenantId),
    session ? getPendingProcurementApprovals(tenantId, session.userId) : Promise.resolve([]),
  ])
  const { summary, requisitions } = chain

  const metrics = [
    { label: "Requisitions", value: String(summary.requisitions) },
    { label: "Pending approvals", value: String(summary.pendingApprovals) },
    { label: "Open orders", value: String(summary.openOrders) },
    { label: "Committed value", value: inr(summary.committedValue) },
    { label: "Received value", value: inr(summary.receivedValue) },
    { label: "Paid value", value: inr(summary.paidValue) },
  ]

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShoppingCart className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Procurement Management</h1>
            <p className="text-sm text-muted-foreground text-pretty">
              Requisition to purchase order, receipt, three-way match and vendor payment.
            </p>
          </div>
        </div>
      </header>

      <section aria-label="Procurement summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">{m.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{m.value}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section aria-label="Procurement stages" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {STAGES.map((stage) => (
          <Link key={stage.href} href={stage.href} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/50">
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <div className="flex items-center gap-2">
                  <stage.icon className="size-4 text-muted-foreground" aria-hidden />
                  <CardTitle className="text-sm">{stage.title}</CardTitle>
                </div>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground text-pretty">{stage.blurb}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent requisitions</CardTitle>
          </CardHeader>
          <CardContent>
            {requisitions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No requisitions yet. Raise one to start the chain.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Requisition</th>
                      <th className="py-2 pr-3 font-medium">Department</th>
                      <th className="py-2 pr-3 text-right font-medium">Estimated</th>
                      <th className="py-2 pr-3 font-medium">Approval</th>
                      <th className="py-2 font-medium">Stage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requisitions.slice(0, 12).map((r: any) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium">{r.requisition_id}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{r.department || "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{inr(Number(r.estimated_amount))}</td>
                        <td className="py-2 pr-3">{approvalBadge(String(r.approval_status || ""))}</td>
                        <td className="py-2 text-muted-foreground">{r.requisition_status || "Open"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Awaiting your approval</CardTitle>
          </CardHeader>
          <CardContent>
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is waiting on you right now.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {pending.slice(0, 10).map((p: any) => (
                  <li key={`${p.moduleKey}-${p.id}`} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.ref}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.title || p.moduleKey}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm tabular-nums">{inr(Number(p.amount))}</span>
                      {!p.canDecide ? (
                        <span className="text-[10px] text-muted-foreground">You raised this</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
