"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { useNewRecordParam } from "@/lib/use-new-record-param"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MoreHorizontal, Plus, Search } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { QuotationDialog } from "@/components/sales/quotation-dialog"
import { QuotationDetailDrawer } from "@/components/sales/quotation-detail-drawer"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type QuotationRow = {
  id: number
  quote_code: string
  version?: number
  is_current?: number
  quote_date: string | null
  company_name: string | null
  contact_person: string | null
  opportunity_name: string | null
  total_amount: number
  grand_total?: number
  valid_until: string | null
  status: string
  added_by_name: string | null
  owner_name?: string | null
  created_at: string
}

type Analytics = {
  total: number
  pipelineValue: number
  wonValue: number
  accepted: number
  rejected: number
  sent: number
  draft: number
  winRate: number
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Draft: "outline",
  Sent: "secondary",
  Accepted: "default",
  Rejected: "destructive",
  Expired: "destructive",
  Cancelled: "outline",
}

const STATUS_FILTERS = ["All", "Draft", "Sent", "Accepted", "Rejected", "Expired", "Cancelled"]

async function runAction(id: number, body: Record<string, any>) {
  const res = await fetch(`/api/sales/quotations/${id}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "Action failed")
  return data
}

export function QuotationsClient({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState("All")
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<QuotationRow | null>(null)

  // SPEC 82 — open the create dialog when the command palette deep-links here.
  useNewRecordParam(() => {
    setEditing(null)
    setDialogOpen(true)
  }, canManage)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const listKey = `/api/sales/quotations${status !== "All" ? `?status=${status}` : ""}`
  const { data, isLoading, mutate } = useSWR<{ quotations: QuotationRow[] }>(listKey, fetcher)
  const { data: analytics, mutate: mutateAnalytics } = useSWR<Analytics>("/api/sales/quotations/analytics", fetcher)

  const quotations = data?.quotations ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return quotations
    return quotations.filter((v) =>
      [v.company_name, v.contact_person, v.opportunity_name, v.quote_code]
        .filter(Boolean)
        .some((f) => f!.toLowerCase().includes(q)),
    )
  }, [quotations, search])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/quotations/${id}`,
    labels: { singular: "quotation", plural: "quotations" },
    mutate,
    onDeleted: clear,
  })

  function refresh() {
    mutate()
    mutateAnalytics()
  }

  async function doAction(id: number, body: Record<string, any>, successMsg: string) {
    setBusy(id)
    try {
      await runAction(id, body)
      toast.success(successMsg)
      refresh()
    } catch (err: any) {
      toast.error(err.message || "Action failed")
    } finally {
      setBusy(null)
    }
  }

  function openPdf(id: number, download = false) {
    window.open(`/api/sales/quotations/${id}/pdf${download ? "?download=1" : ""}`, "_blank")
  }

  const cards: Array<{ label: string; value: string; hint?: string }> = analytics
    ? [
        { label: "Total quotations", value: String(analytics.total), hint: `${analytics.draft} draft · ${analytics.sent} sent` },
        { label: "Pipeline value", value: formatCurrency(analytics.pipelineValue) },
        { label: "Won value", value: formatCurrency(analytics.wonValue), hint: `${analytics.accepted} accepted` },
        { label: "Win rate", value: `${analytics.winRate}%`, hint: `${analytics.rejected} rejected` },
      ]
    : []

  return (
    <div className="flex flex-col gap-4">
      {/* Analytics summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
              <span className="text-xl font-semibold tabular-nums">{c.value}</span>
              {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search quotations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v ?? "All")}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "All" ? "All statuses" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-quotations" onImported={refresh} />}
          <ExcelExportButton
            rows={filtered}
            filename="quotations"
            columns={[
              { header: "Quote Code", value: (r) => r.quote_code },
              { header: "Date", value: (r) => r.quote_date },
              { header: "Company", value: (r) => r.company_name },
              { header: "Contact Person", value: (r) => r.contact_person },
              { header: "Opportunity", value: (r) => r.opportunity_name },
              { header: "Amount", value: (r) => r.grand_total ?? r.total_amount },
              { header: "Valid Until", value: (r) => r.valid_until },
              { header: "Status", value: (r) => r.status },
              { header: "Owner", value: (r) => r.owner_name },
              { header: "Added By", value: (r) => r.added_by_name },
            ]}
          />
          {canManage && (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              Create quotation
            </Button>
          )}
        </div>
      </div>

      {canManage && selected.size > 0 && (
        <SelectionToolbar
          count={selected.size}
          noun="quotation"
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
                  <SelectAllCheckbox ids={filtered.map((q) => q.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Quote</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Opportunity</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading quotations...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No quotations found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((quotation) => {
              const amount = quotation.grand_total ?? quotation.total_amount
              const canEdit = quotation.status === "Draft"
              const isActive = ["Draft", "Sent"].includes(quotation.status)
              return (
                <TableRow
                  key={quotation.id}
                  data-state={selected.has(quotation.id) ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => setDetailId(quotation.id)}
                >
                  {canManage && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select quotation ${quotation.quote_code}`}
                        checked={selected.has(quotation.id)}
                        onCheckedChange={() => toggle(quotation.id)}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {quotation.quote_code}
                        {quotation.version && quotation.version > 1 ? (
                          <span className="ml-1 text-xs text-muted-foreground">v{quotation.version}</span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{formatDate(quotation.quote_date)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{quotation.company_name || "—"}</span>
                      <span className="text-xs text-muted-foreground">{quotation.contact_person || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{quotation.opportunity_name || "—"}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatCurrency(amount)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(quotation.valid_until)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[quotation.status] || "outline"}>{quotation.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setDetailId(quotation.id)}>View details</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openPdf(quotation.id)}>View PDF</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openPdf(quotation.id, true)}>Download PDF</DropdownMenuItem>
                        {canManage && (
                          <>
                            <DropdownMenuSeparator />
                            {canEdit && (
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditing(quotation)
                                  setDialogOpen(true)
                                }}
                              >
                                Edit
                              </DropdownMenuItem>
                            )}
                            {quotation.status === "Draft" && (
                              <DropdownMenuItem
                                disabled={busy === quotation.id}
                                onClick={() => doAction(quotation.id, { action: "send" }, "Quotation sent")}
                              >
                                Mark as sent
                              </DropdownMenuItem>
                            )}
                            {quotation.status === "Sent" && (
                              <>
                                <DropdownMenuItem
                                  disabled={busy === quotation.id}
                                  onClick={() => doAction(quotation.id, { action: "accept" }, "Quotation accepted")}
                                >
                                  Mark accepted
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={busy === quotation.id}
                                  onClick={() => doAction(quotation.id, { action: "reject" }, "Quotation rejected")}
                                >
                                  Mark rejected
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuItem
                              disabled={busy === quotation.id}
                              onClick={() => doAction(quotation.id, { action: "revise" }, "New revision created")}
                            >
                              Create revision
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busy === quotation.id}
                              onClick={() => doAction(quotation.id, { action: "duplicate" }, "Quotation duplicated")}
                            >
                              Duplicate
                            </DropdownMenuItem>
                            {quotation.status === "Accepted" && (
                              <>
                                <DropdownMenuItem
                                  disabled={busy === quotation.id}
                                  onClick={() =>
                                    doAction(quotation.id, { action: "convert-invoice" }, "Converted to invoice")
                                  }
                                >
                                  Convert to invoice
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={busy === quotation.id}
                                  onClick={() =>
                                    doAction(quotation.id, { action: "convert-contract" }, "Converted to contract")
                                  }
                                >
                                  Convert to contract
                                </DropdownMenuItem>
                              </>
                            )}
                            {isActive && (
                              <DropdownMenuItem
                                disabled={busy === quotation.id}
                                onClick={() => doAction(quotation.id, { action: "cancel" }, "Quotation cancelled")}
                              >
                                Cancel
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => del.requestSingle(quotation.id, `quotation ${quotation.quote_code}`)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <QuotationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        quotation={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Quotation updated" : "Quotation created")
          refresh()
        }}
      />

      <QuotationDetailDrawer
        id={detailId}
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        canManage={canManage}
        onChanged={refresh}
      />

      {del.dialog}
    </div>
  )
}
