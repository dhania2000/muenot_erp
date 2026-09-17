"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2, Loader2 } from "lucide-react"
import type { Plan, SubscriptionWithTenant, InvoiceWithTenant, SubscriptionStatus } from "@/lib/platform-console"
import { formatCurrency, formatDate } from "@/lib/platform-format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const statusVariant: Record<SubscriptionStatus, "default" | "secondary" | "destructive"> = {
  active: "default",
  trialing: "secondary",
  past_due: "destructive",
  canceled: "secondary",
}

const invoiceVariant: Record<InvoiceWithTenant["status"], "default" | "secondary" | "destructive"> = {
  paid: "default",
  open: "destructive",
  void: "secondary",
}

const SUB_STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due", "canceled"]

export function SubscriptionsManager({
  plans,
  subscriptions,
  invoices,
  canManagePlans,
}: {
  plans: Plan[]
  subscriptions: SubscriptionWithTenant[]
  invoices: InvoiceWithTenant[]
  canManagePlans: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const activePlans = plans.filter((p) => p.is_active)

  async function patchSub(tenantId: number, payload: Record<string, unknown>, key: string) {
    setPending(key)
    try {
      const res = await fetch("/api/platform/subscriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, ...payload }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update subscription")
        return
      }
      toast.success("Subscription updated")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPending(null)
    }
  }

  async function payInvoice(invoiceId: number) {
    setPending(`inv-${invoiceId}`)
    try {
      const res = await fetch("/api/platform/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update invoice")
        return
      }
      toast.success("Invoice marked paid")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPending(null)
    }
  }

  return (
    <Tabs defaultValue="subscriptions" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
        <TabsTrigger value="invoices">Invoices</TabsTrigger>
        <TabsTrigger value="plans">Plans</TabsTrigger>
      </TabsList>

      <TabsContent value="subscriptions">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Tenant subscriptions</CardTitle>
            <CardDescription>Change a tenant&apos;s plan or lifecycle status. MRR is resolved from the plan.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>MRR</TableHead>
                  <TableHead>Renews</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.tenant_name}</TableCell>
                    <TableCell>
                      <Select
                        value={s.plan_code}
                        onValueChange={(v) => patchSub(s.tenant_id, { planCode: v }, `plan-${s.id}`)}
                        disabled={pending === `plan-${s.id}`}
                      >
                        <SelectTrigger className="h-8 w-[9.5rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {activePlans.map((p) => (
                            <SelectItem key={p.code} value={p.code}>
                              {p.name}
                            </SelectItem>
                          ))}
                          {activePlans.some((p) => p.code === s.plan_code) ? null : (
                            <SelectItem value={s.plan_code}>{s.plan_name}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatCurrency(s.mrr, s.currency)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(s.current_period_end)}</TableCell>
                    <TableCell>
                      <Select
                        value={s.status}
                        onValueChange={(v) => patchSub(s.tenant_id, { status: v }, `status-${s.id}`)}
                        disabled={pending === `status-${s.id}`}
                      >
                        <SelectTrigger className="h-8 w-[8.5rem]">
                          <SelectValue asChild>
                            <Badge variant={statusVariant[s.status]} className="capitalize">
                              {s.status.replace(/_/g, " ")}
                            </Badge>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {SUB_STATUSES.map((st) => (
                            <SelectItem key={st} value={st} className="capitalize">
                              {st.replace(/_/g, " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="invoices">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Invoices</CardTitle>
            <CardDescription>Derived from active subscriptions. Record payment against open invoices.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No invoices yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  invoices.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-mono text-xs">{i.invoice_number}</TableCell>
                      <TableCell className="font-medium">{i.tenant_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(i.period_start)} – {formatDate(i.period_end)}
                      </TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(i.amount, i.currency)}</TableCell>
                      <TableCell>
                        <Badge variant={invoiceVariant[i.status]} className="capitalize">
                          {i.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {i.status === "open" ? (
                          <Button size="sm" variant="secondary" onClick={() => payInvoice(i.id)} disabled={pending === `inv-${i.id}`}>
                            {pending === `inv-${i.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="size-3.5" />
                            )}
                            Mark paid
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {i.status === "paid" ? `Paid ${formatDate(i.paid_at)}` : "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="plans">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => (
            <Card key={p.code} className={p.is_active ? undefined : "opacity-60"}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <Badge variant={p.is_active ? "default" : "secondary"}>{p.is_active ? "Active" : "Inactive"}</Badge>
                </div>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold tabular-nums">{formatCurrency(p.price_monthly, p.currency)}</span>
                  <span className="text-xs text-muted-foreground">/mo</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.seat_limit != null ? `${p.seat_limit} seats` : "Unlimited seats"}
                </p>
                <ul className="flex flex-col gap-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3 text-emerald-500" />
                      {f.replace(/_/g, " ")}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
        {!canManagePlans ? (
          <p className="mt-4 text-xs text-muted-foreground">Plan catalog editing requires platform super-admin authority.</p>
        ) : null}
      </TabsContent>
    </Tabs>
  )
}
