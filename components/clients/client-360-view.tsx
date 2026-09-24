"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EntityCombobox, type ComboOption } from "@/components/clients/entity-combobox"
import type { ClientRow } from "@/components/clients/clients-client"
import {
  ArrowLeft,
  BookOpen,
  Building2,
  FileText,
  Loader2,
  Mail,
  Pencil,
  Phone,
  ReceiptText,
  Star,
  UserRound,
  Users,
} from "lucide-react"

type Aging = { current: number; d1_30: number; d31_60: number; d61_90: number; d91_180: number; d180: number }

type Summary = {
  client: ClientRow & {
    linked_company_name?: string | null
    finance_party_name?: string | null
    finance_invoice_email?: string | null
    account_manager_name?: string | null
  }
  finance: {
    linked: boolean
    finance_party_id: string | null
    total_invoiced: number
    total_paid: number
    outstanding: number
    overdue: number
    pending_tds: number
    credit_limit: number | null
    available_credit: number | null
    utilization: number | null
    invoice_count: number
    last_invoice: { invoice_id: string; invoice_date: string; invoice_total: number } | null
    next_due: string | null
    aging: Aging
    invoices: any[]
  }
  sales: {
    linked: boolean
    open_leads: number
    won_leads: number
    lost_leads: number
    open_quotations: number
    accepted_quotations: number
    active_contracts: number
    forecast_value: number
  }
  contacts: {
    id: number
    name: string
    title: string | null
    email: string | null
    phone: string | null
    is_primary: number
  }[]
  timeline: { type: string; action: string; summary: string; at: string }[]
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "positive" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          "mt-1 text-lg font-semibold tabular-nums " +
          (tone === "danger" ? "text-destructive" : tone === "positive" ? "text-emerald-600 dark:text-emerald-400" : "")
        }
      >
        {value}
      </div>
    </div>
  )
}

export function Client360View({
  canManage,
  initialClientId,
}: {
  canManage: boolean
  initialClientId: number | null
}) {
  const [selectedId, setSelectedId] = useState<number | null>(initialClientId)

  const { data: list } = useSWR<{ clients: ClientRow[] }>("/api/clients", fetcher)
  const clients = list?.clients ?? []

  const selectedFromList = useMemo(
    () => clients.find((c) => c.id === selectedId) ?? null,
    [clients, selectedId],
  )

  const { data, isLoading } = useSWR<Summary>(
    selectedId ? `/api/clients/${selectedId}/summary` : null,
    fetcher,
  )

  const searchClients = useCallback(
    async (q: string): Promise<ComboOption[]> => {
      const term = q.trim().toLowerCase()
      const source = clients.filter((c) => !c.archived_at)
      const matched = term
        ? source.filter((c) =>
            [c.client_code, c.client_name, c.email, c.company_name, c.gst_number, c.pan, c.city, c.country]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(term)),
          )
        : source
      return matched.slice(0, 25).map((c) => ({
        value: String(c.id),
        label: c.company_name || c.client_name,
        sub: [c.client_code, c.email].filter(Boolean).join(" · "),
        data: c,
      }))
    },
    [clients],
  )

  const ccy = data?.client?.currency || selectedFromList?.currency || "INR"
  const fin = data?.finance
  const sales = data?.sales
  const header = data?.client || selectedFromList

  const agingRows: [string, keyof Aging][] = [
    ["Current", "current"],
    ["1–30", "d1_30"],
    ["31–60", "d31_60"],
    ["61–90", "d61_90"],
    ["91–180", "d91_180"],
    ["180+", "d180"],
  ]

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      {/* Page header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Users className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Client 360</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            A unified view of every client — profile, finance, sales, contacts and activity.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/modules/clients/clients" />}>
          <ArrowLeft className="size-4" /> Back to clients
        </Button>
      </div>

      {/* Client picker -------------------------------------------------------- */}
      <div className="grid gap-2 sm:max-w-md">
        <label className="text-sm font-medium">Select client</label>
        <EntityCombobox
          selectedLabel={header ? header.company_name || header.client_name : null}
          placeholder="Search clients by name, code, email, GSTIN…"
          emptyText="No clients found"
          onSearch={searchClients}
          onSelect={(opt) => setSelectedId(Number(opt.value))}
          onClear={() => setSelectedId(null)}
        />
      </div>

      {/* Empty state ---------------------------------------------------------- */}
      {!selectedId && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 py-20 text-center">
          <Building2 className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No client selected</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Choose a client above to see their complete 360 profile — outstanding balance, ageing, invoices, sales
            pipeline, contacts and timeline.
          </p>
        </div>
      )}

      {/* Loading -------------------------------------------------------------- */}
      {selectedId && (isLoading || !data) && (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading client 360…
        </div>
      )}

      {/* Detail --------------------------------------------------------------- */}
      {selectedId && data && header && (
        <div className="grid gap-6">
          {/* Identity card */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-4">
            <span className="flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{header.company_name || header.client_name}</h2>
                {header.client_code && (
                  <span className="font-mono text-xs text-muted-foreground">{header.client_code}</span>
                )}
                {header.status && (
                  <Badge variant={header.status === "Active" ? "default" : "destructive"}>{header.status}</Badge>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {header.email && (
                  <span className="flex items-center gap-1">
                    <Mail className="size-3" /> {header.email}
                  </span>
                )}
                {header.mobile && (
                  <span className="flex items-center gap-1">
                    <Phone className="size-3" /> {header.mobile}
                  </span>
                )}
                {[header.city, header.country].filter(Boolean).length > 0 && (
                  <span>{[header.city, header.country].filter(Boolean).join(", ")}</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && (
                <Button size="sm" variant="outline" render={<Link href="/modules/clients/clients" />}>
                  <Pencil className="size-4" /> Manage
                </Button>
              )}
              <Button size="sm" variant="outline" render={<Link href="/modules/finance/sales-invoices" />}>
                <ReceiptText className="size-4" /> New invoice
              </Button>
              <Button size="sm" variant="outline" render={<Link href="/modules/finance/general-ledger" />}>
                <BookOpen className="size-4" /> Ledger
              </Button>
            </div>
          </div>

          {/* Top-line KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total invoiced" value={formatCurrency(fin?.total_invoiced, ccy)} />
            <Stat label="Total paid" value={formatCurrency(fin?.total_paid, ccy)} tone="positive" />
            <Stat label="Outstanding" value={formatCurrency(fin?.outstanding, ccy)} />
            <Stat
              label="Overdue"
              value={formatCurrency(fin?.overdue, ccy)}
              tone={fin && fin.overdue > 0 ? "danger" : undefined}
            />
          </div>

          <Tabs defaultValue="finance">
            <TabsList>
              <TabsTrigger value="finance">Finance</TabsTrigger>
              <TabsTrigger value="sales">Sales</TabsTrigger>
              <TabsTrigger value="contacts">Contacts</TabsTrigger>
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            {/* FINANCE ---------------------------------------------------------- */}
            <TabsContent value="finance" className="grid gap-4">
              {!fin?.linked && (
                <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  No finance party linked. Figures below aggregate invoices matched by client code.
                </p>
              )}

              {fin?.credit_limit != null && (
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Credit utilization</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatCurrency(fin.outstanding, ccy)} / {formatCurrency(fin.credit_limit, ccy)}
                    </span>
                  </div>
                  <Progress value={Math.min(100, fin.utilization ?? 0)} className="mt-2" />
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Available: {formatCurrency(fin.available_credit, ccy)}</span>
                    <span
                      className={
                        fin.utilization != null && fin.utilization >= 100 ? "font-medium text-destructive" : ""
                      }
                    >
                      {fin.utilization != null ? `${fin.utilization}% used` : "—"}
                    </span>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Invoices" value={String(fin?.invoice_count ?? 0)} />
                <Stat label="Last invoice" value={fin?.last_invoice ? formatDate(fin.last_invoice.invoice_date) : "—"} />
                <Stat label="Pending TDS" value={formatCurrency(fin?.pending_tds, ccy)} />
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold">Ageing</h4>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {agingRows.map(([label, key]) => (
                    <div key={key} className="rounded-md border border-border bg-muted/30 p-2 text-center">
                      <div className="text-[11px] text-muted-foreground">{label}</div>
                      <div className="text-sm font-medium tabular-nums">
                        {formatCurrency(fin?.aging?.[key] ?? 0, ccy)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {fin && fin.invoices.length > 0 ? (
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fin.invoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-xs">{inv.invoice_id}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(inv.invoice_date)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(inv.invoice_total, ccy)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(inv.outstanding_amount, ccy)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{inv.payment_status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">No invoices for this client yet.</p>
              )}
            </TabsContent>

            {/* SALES ------------------------------------------------------------ */}
            <TabsContent value="sales" className="grid gap-4">
              {!sales?.linked && (
                <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Link a company account to surface leads, quotations and contracts.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Open leads" value={String(sales?.open_leads ?? 0)} />
                <Stat label="Won leads" value={String(sales?.won_leads ?? 0)} tone="positive" />
                <Stat label="Lost leads" value={String(sales?.lost_leads ?? 0)} />
                <Stat label="Open quotations" value={String(sales?.open_quotations ?? 0)} />
                <Stat label="Accepted quotations" value={String(sales?.accepted_quotations ?? 0)} tone="positive" />
                <Stat label="Active contracts" value={String(sales?.active_contracts ?? 0)} />
              </div>
            </TabsContent>

            {/* CONTACTS --------------------------------------------------------- */}
            <TabsContent value="contacts" className="grid gap-3">
              {data.contacts.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No contacts on the linked account.</p>
              ) : (
                data.contacts.map((c) => (
                  <div key={c.id} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
                    <span className="flex size-8 items-center justify-center rounded-full bg-muted">
                      <UserRound className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        {!!c.is_primary && (
                          <Badge variant="outline" className="gap-1">
                            <Star className="size-3" /> Primary
                          </Badge>
                        )}
                        {c.title && <span className="text-xs text-muted-foreground">{c.title}</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {c.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="size-3" /> {c.email}
                          </span>
                        )}
                        {c.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="size-3" /> {c.phone}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* PROFILE ---------------------------------------------------------- */}
            <TabsContent value="profile" className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <ProfileGroup title="Identity">
                  <Row label="Display name" value={data.client.display_name || data.client.client_name} />
                  <Row label="Legal name" value={data.client.legal_name} />
                  <Row label="Type" value={data.client.client_type} />
                  <Row label="Company account" value={data.client.linked_company_name} />
                  <Row label="Account manager" value={data.client.account_manager_name} />
                </ProfileGroup>
                <ProfileGroup title="Tax profile">
                  <Row label="GSTIN" value={data.client.gst_number} mono />
                  <Row label="PAN" value={data.client.pan} mono />
                  <Row
                    label="State"
                    value={[data.client.state, data.client.state_code].filter(Boolean).join(" · ")}
                  />
                </ProfileGroup>
                <ProfileGroup title="Billing">
                  <Row label="Currency" value={data.client.currency} />
                  <Row
                    label="Payment terms"
                    value={data.client.payment_terms_days ? `${data.client.payment_terms_days} days` : null}
                  />
                  <Row
                    label="Credit limit"
                    value={data.client.credit_limit != null ? formatCurrency(data.client.credit_limit, ccy) : null}
                  />
                  <Row label="Invoice email" value={data.client.finance_invoice_email || data.client.email} />
                  <Row label="Finance party" value={data.client.finance_party_name || data.client.finance_party_id} />
                </ProfileGroup>
                <ProfileGroup title="Contact & location">
                  <Row label="Email" value={data.client.email} />
                  <Row label="Mobile" value={data.client.mobile} />
                  <Row
                    label="Address"
                    value={[data.client.address, data.client.city, data.client.country].filter(Boolean).join(", ")}
                  />
                </ProfileGroup>
              </div>
              {data.client.notes && (
                <div>
                  <Separator className="my-1" />
                  <h4 className="mb-1 text-sm font-semibold">Notes</h4>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.client.notes}</p>
                </div>
              )}
            </TabsContent>

            {/* TIMELINE --------------------------------------------------------- */}
            <TabsContent value="timeline" className="grid gap-3">
              {data.timeline.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <ol className="relative ml-2 border-l border-border">
                  {data.timeline.map((e, i) => (
                    <li key={i} className="mb-4 ml-4">
                      <span className="absolute -left-1.5 mt-1.5 flex size-3 items-center justify-center rounded-full bg-primary" />
                      <div className="flex items-center gap-2">
                        {e.type === "invoice" ? (
                          <FileText className="size-3.5 text-muted-foreground" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-muted-foreground" />
                        )}
                        <span className="text-sm capitalize">{e.action}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(e.at)}</span>
                      </div>
                      {e.summary && <p className="ml-5 text-xs text-muted-foreground">{e.summary}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  )
}

function ProfileGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="grid gap-1.5">{children}</dl>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={"text-right " + (mono ? "font-mono text-xs" : "")}>{value || "—"}</dd>
    </div>
  )
}
