"use client"

import { Fragment, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
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
import { Search, ShoppingCart, ChevronDown, ChevronRight } from "lucide-react"

type PortalOrderLineItem = {
  productId: number
  productCode: string | null
  name: string
  unit: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
}

type PortalOrder = {
  id: number
  client_id: number
  client_name: string | null
  reference: string | null
  title: string
  description: string | null
  status: string | null
  amount: number | null
  currency: string | null
  issue_date: string | null
  placed_by: string | null
  created_at: string
  items?: PortalOrderLineItem[]
}

type ApiResponse = { orders: PortalOrder[]; counts: Record<string, number> }

const STATUSES = ["Requested", "Confirmed", "In Progress", "Fulfilled", "Cancelled"] as const
type Status = (typeof STATUSES)[number]

const STATUS_STYLE: Record<string, string> = {
  Requested: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Confirmed: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "In Progress": "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  Fulfilled: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  Cancelled: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
}

export function PortalOrdersClient({
  initialOrders,
  initialCounts,
  canManage,
}: {
  initialOrders: PortalOrder[]
  initialCounts: Record<string, number>
  canManage: boolean
}) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data, mutate } = useSWR<ApiResponse>("/api/sales/portal-orders", fetcher, {
    fallbackData: { orders: initialOrders, counts: initialCounts },
    revalidateOnFocus: false,
  })

  const orders = data?.orders ?? []
  const counts = data?.counts ?? {}
  const total = orders.length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (statusFilter !== "all" && (o.status ?? "Requested") !== statusFilter) return false
      if (!q) return true
      return (
        o.title.toLowerCase().includes(q) ||
        (o.reference ?? "").toLowerCase().includes(q) ||
        (o.client_name ?? "").toLowerCase().includes(q) ||
        (o.placed_by ?? "").toLowerCase().includes(q)
      )
    })
  }, [orders, search, statusFilter])

  async function updateStatus(order: PortalOrder, status: Status) {
    setUpdatingId(order.id)
    // Optimistic update.
    mutate(
      (prev) =>
        prev
          ? { ...prev, orders: prev.orders.map((o) => (o.id === order.id ? { ...o, status } : o)) }
          : prev,
      { revalidate: false },
    )
    try {
      const res = await fetch("/api/sales/portal-orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || "Update failed")
      }
      toast.success(`Order ${order.reference ?? order.id} → ${status}`)
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update order")
      mutate()
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales Order Management</h1>
        <p className="text-sm text-muted-foreground">
          Orders placed by clients through the client portal. Review and advance each order through its lifecycle.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="text-2xl font-semibold">{total}</span>
          </CardContent>
        </Card>
        {STATUSES.map((s) => (
          <Card key={s}>
            <CardContent className="flex flex-col gap-1 p-4">
              <span className="text-xs text-muted-foreground">{s}</span>
              <span className="text-2xl font-semibold">{counts[s] ?? 0}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search orders, client, or reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Reference</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Placed by</TableHead>
              <TableHead>Placed on</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <ShoppingCart className="h-8 w-8" />
                    <p className="text-sm">
                      {orders.length === 0
                        ? "No client orders yet. Orders placed from the client portal will appear here."
                        : "No orders match your filters."}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((o) => {
                const lineItems = o.items ?? []
                const hasItems = lineItems.length > 0
                const isExpanded = expandedId === o.id
                return (
                  <Fragment key={o.id}>
                    <TableRow>
                      <TableCell className="p-0 pl-2">
                        {hasItems && (
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : o.id)}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                            aria-label={isExpanded ? "Collapse line items" : "Expand line items"}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{o.reference ?? `#${o.id}`}</TableCell>
                      <TableCell>{o.client_name ?? "—"}</TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="font-medium truncate">{o.title}</div>
                        {hasItems ? (
                          <div className="text-xs text-muted-foreground">
                            {lineItems.length} product{lineItems.length === 1 ? "" : "s"}
                          </div>
                        ) : (
                          o.description && (
                            <div className="text-xs text-muted-foreground truncate">{o.description}</div>
                          )
                        )}
                      </TableCell>
                      <TableCell>{o.placed_by ?? "—"}</TableCell>
                      <TableCell>{o.issue_date ? formatDate(o.issue_date) : formatDate(o.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {o.amount != null ? formatCurrency(o.amount, o.currency ?? undefined) : "—"}
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <Select
                            value={o.status ?? "Requested"}
                            onValueChange={(v) => updateStatus(o, v as Status)}
                            disabled={updatingId === o.id}
                          >
                            <SelectTrigger className="w-[150px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="secondary" className={STATUS_STYLE[o.status ?? "Requested"]}>
                            {o.status ?? "Requested"}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                    {isExpanded && hasItems && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="bg-muted/30 p-0">
                          <div className="px-6 py-3">
                            {o.description && (
                              <p className="mb-3 text-sm text-muted-foreground">
                                <span className="font-medium text-foreground">Notes: </span>
                                {o.description}
                              </p>
                            )}
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="h-8">Product</TableHead>
                                  <TableHead className="h-8">Code</TableHead>
                                  <TableHead className="h-8 text-right">Unit price</TableHead>
                                  <TableHead className="h-8 text-right">Qty</TableHead>
                                  <TableHead className="h-8 text-right">Line total</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {lineItems.map((it) => (
                                  <TableRow key={it.productId} className="hover:bg-transparent">
                                    <TableCell className="py-2">{it.name}</TableCell>
                                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">
                                      {it.productCode ?? "—"}
                                    </TableCell>
                                    <TableCell className="py-2 text-right tabular-nums">
                                      {formatCurrency(it.unitPrice, o.currency ?? undefined)}
                                    </TableCell>
                                    <TableCell className="py-2 text-right tabular-nums">
                                      {it.quantity}
                                      {it.unit ? ` ${it.unit}` : ""}
                                    </TableCell>
                                    <TableCell className="py-2 text-right tabular-nums">
                                      {formatCurrency(it.lineTotal, o.currency ?? undefined)}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
