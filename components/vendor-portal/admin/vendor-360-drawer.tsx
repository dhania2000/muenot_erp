"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Building2,
  CheckCircle2,
  XCircle,
  Power,
  PauseCircle,
  Ban,
  Info,
  Send,
  RotateCcw,
  LogOut,
  Mail,
  Phone,
  Calendar,
  CreditCard,
  Coins,
} from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge, EmptyState } from "./shared"
import {
  type Vendor,
  PORTAL_STATUS_LABEL,
  ONBOARDING_STATUS_LABEL,
  COMPLIANCE_STATUS_LABEL,
  PORTAL_USERS,
  COMPLIANCE_DOCS,
  VENDOR_DOCUMENTS,
  PORTAL_INVOICES,
  PORTAL_PAYMENTS,
  PORTAL_POS,
  PORTAL_CONTRACTS,
  PORTAL_SESSIONS,
  BANK_DETAILS,
  AUDIT_ENTRIES,
  ONBOARDING_WORKFLOW,
  PORTAL_RESOURCES,
  INVOICE_STATUS_LABEL,
  formatMoney,
} from "./mock-data"

const TABS = [
  "overview",
  "users",
  "access",
  "onboarding",
  "company",
  "bank",
  "tax",
  "compliance",
  "documents",
  "invoices",
  "payments",
  "pos",
  "contracts",
  "activity",
  "sessions",
  "security",
  "audit",
] as const

const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  overview: "Overview",
  users: "Portal Users",
  access: "Access & Permissions",
  onboarding: "Onboarding",
  company: "Company Details",
  bank: "Bank Details",
  tax: "Tax Details",
  compliance: "Compliance",
  documents: "Documents",
  invoices: "Invoices",
  payments: "Payments",
  pos: "Purchase Orders",
  contracts: "Contracts",
  activity: "Activity",
  sessions: "Sessions",
  security: "Security",
  audit: "Audit History",
}

const ACTIONS = [
  { key: "approve", label: "Approve", icon: CheckCircle2 },
  { key: "reject", label: "Reject", icon: XCircle, variant: "destructive" as const },
  { key: "activate", label: "Activate", icon: Power },
  { key: "suspend", label: "Suspend", icon: PauseCircle },
  { key: "disable", label: "Disable", icon: Ban, variant: "destructive" as const },
  { key: "info", label: "Request Info", icon: Info },
  { key: "resend", label: "Resend Invite", icon: Send },
  { key: "reset", label: "Reset Access", icon: RotateCcw },
  { key: "revoke", label: "Revoke Sessions", icon: LogOut, variant: "destructive" as const },
]

function Field({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon?: typeof Mail }) {
  return (
    <div className="grid gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-3.5" /> : null}
        {label}
      </span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

export function Vendor360Drawer({ vendor, onClose }: { vendor: Vendor | null; onClose: () => void }) {
  const [tab, setTab] = useState<string>("overview")
  const open = vendor !== null

  if (!vendor) return null

  const vendorUsers = PORTAL_USERS.filter((u) => u.vendor === vendor.name)
  const vendorCompliance = COMPLIANCE_DOCS.filter((c) => c.vendor === vendor.name)
  const vendorDocs = VENDOR_DOCUMENTS.filter((d) => d.vendor === vendor.name)
  const vendorInvoices = PORTAL_INVOICES.filter((i) => i.vendor === vendor.name)
  const vendorPayments = PORTAL_PAYMENTS.filter((p) => p.vendor === vendor.name)
  const vendorPOs = PORTAL_POS.filter((p) => p.vendor === vendor.name)
  const vendorContracts = PORTAL_CONTRACTS.filter((c) => c.vendor === vendor.name)
  const vendorSessions = PORTAL_SESSIONS.filter((s) => s.vendor === vendor.name)
  const vendorBank = BANK_DETAILS.filter((b) => b.vendor === vendor.name)
  const vendorAudit = AUDIT_ENTRIES.filter((a) => a.vendor === vendor.name)

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <div className="flex items-start gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="size-5" />
            </span>
            <div className="grid gap-1">
              <SheetTitle className="flex items-center gap-2">
                {vendor.name}
                <span className="font-mono text-xs font-normal text-muted-foreground">{vendor.code}</span>
              </SheetTitle>
              <SheetDescription>{vendor.company}</SheetDescription>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <StatusBadge status={vendor.portalStatus} label={PORTAL_STATUS_LABEL[vendor.portalStatus]} />
                <StatusBadge status={vendor.onboarding} label={ONBOARDING_STATUS_LABEL[vendor.onboarding]} />
                <StatusBadge status={vendor.compliance} label={COMPLIANCE_STATUS_LABEL[vendor.compliance]} />
              </div>
            </div>
          </div>
        </SheetHeader>

        {/* Action bar */}
        <div className="flex flex-wrap gap-1.5 border-y border-border py-3">
          {ACTIONS.map((a) => (
            <Button
              key={a.key}
              size="xs"
              variant={a.variant ?? "outline"}
              onClick={() => toast.success(`${a.label} — ${vendor.name}`)}
            >
              <a.icon className="size-3.5" />
              {a.label}
            </Button>
          ))}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="min-h-0 flex-1">
          <div className="-mx-1 overflow-x-auto pb-1">
            <TabsList variant="line" className="w-max">
              {TABS.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {TAB_LABEL[t]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="pt-4">
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-3">
                <Field label="Vendor ID" value={vendor.code} />
                <Field label="Company" value={vendor.company} icon={Building2} />
                <Field label="Category" value={vendor.category} />
                <Field label="Primary Contact" value={vendor.contact} />
                <Field label="Email" value={vendor.email} icon={Mail} />
                <Field label="Phone" value={vendor.phone} icon={Phone} />
                <Field label="Payment Terms" value={vendor.paymentTerms} icon={CreditCard} />
                <Field label="Currency" value={vendor.currency} icon={Coins} />
                <Field label="Portal Users" value={vendor.users} />
                <Field label="Last Login" value={vendor.lastLogin} icon={Calendar} />
                <Field label="Created" value={vendor.createdDate} icon={Calendar} />
                <Field label="Approved" value={vendor.approvedDate ?? "—"} icon={Calendar} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricBox label="Open invoices" value={vendorInvoices.length} />
                <MetricBox label="Active sessions" value={vendorSessions.filter((s) => s.status === "active").length} />
                <MetricBox label="Documents" value={vendorDocs.length} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="users" className="pt-4">
            {vendorUsers.length === 0 ? (
              <EmptyState title="No portal users" description="This vendor has no login accounts yet." />
            ) : (
              <SimpleTable
                head={["Name", "Email", "Role", "Status", "Last login"]}
                rows={vendorUsers.map((u) => [
                  u.name,
                  u.email,
                  u.role,
                  <StatusBadge key={u.id} status={u.status} label={u.status} />,
                  u.lastLogin,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="access" className="pt-4">
            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Access profile: <span className="font-medium text-foreground">{vendor.accessProfile}</span>
                </p>
                <Button size="xs" variant="outline" onClick={() => toast.success("Access editor opened")}>
                  Edit access
                </Button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {PORTAL_RESOURCES.slice(0, 12).map((r, i) => (
                  <div
                    key={r}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  >
                    <span>{r}</span>
                    <StatusBadge
                      tone={i % 4 === 0 ? "neutral" : "success"}
                      label={i % 4 === 0 ? "No access" : i % 3 === 0 ? "Download" : "View"}
                    />
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="onboarding" className="pt-4">
            <ol className="grid gap-2">
              {ONBOARDING_WORKFLOW.map((step, i) => {
                const done = vendor.onboarding === "completed" || i < 6
                const current = !done && i === 6
                return (
                  <li
                    key={step}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <span
                      className={
                        "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium " +
                        (done
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : current
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-muted text-muted-foreground")
                      }
                    >
                      {done ? <CheckCircle2 className="size-3.5" /> : i + 1}
                    </span>
                    <span className="flex-1 text-sm font-medium">{step}</span>
                    <StatusBadge
                      tone={done ? "success" : current ? "warning" : "neutral"}
                      label={done ? "Completed" : current ? "In progress" : "Pending"}
                    />
                  </li>
                )
              })}
            </ol>
          </TabsContent>

          <TabsContent value="company" className="pt-4">
            <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-3">
              <Field label="Legal name" value={vendor.company} />
              <Field label="Vendor type" value={vendor.type} />
              <Field label="Category" value={vendor.category} />
              <Field label="Country" value={vendor.country} />
              <Field label="Registration No." value="U27100MH2019PTC00" />
              <Field label="Website" value={`www.${vendor.name.toLowerCase().replace(/[^a-z]/g, "")}.com`} />
            </div>
          </TabsContent>

          <TabsContent value="bank" className="pt-4">
            {vendorBank.length === 0 ? (
              <EmptyState title="No bank details" description="No bank information on file for this vendor." />
            ) : (
              <SimpleTable
                head={["Holder", "Bank", "Account", "IFSC/SWIFT", "Status"]}
                rows={vendorBank.map((b) => [
                  b.holder,
                  b.bank,
                  <span key={b.id} className="font-mono text-xs">
                    {b.account}
                  </span>,
                  b.ifsc,
                  <StatusBadge key={b.id + "s"} status={b.status} label={b.status.replace("_", " ")} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="tax" className="pt-4">
            <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-3">
              <Field label="GST/VAT" value="27AABCA1234F1Z5" />
              <Field label="PAN/Tax ID" value="AABCA1234F" />
              <Field label="Tax residency" value={vendor.country} />
              <Field label="TDS applicable" value="Yes — 2%" />
              <Field label="MSME" value="Registered" />
              <Field label="Tax status" value={<StatusBadge tone="success" label="Verified" />} />
            </div>
          </TabsContent>

          <TabsContent value="compliance" className="pt-4">
            {vendorCompliance.length === 0 ? (
              <EmptyState title="No compliance records" />
            ) : (
              <SimpleTable
                head={["Document", "Type", "Number", "Expiry", "Status"]}
                rows={vendorCompliance.map((c) => [
                  c.document,
                  c.type,
                  <span key={c.id} className="font-mono text-xs">
                    {c.number}
                  </span>,
                  c.expiry,
                  <StatusBadge key={c.id + "s"} status={c.status} label={c.status} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="documents" className="pt-4">
            {vendorDocs.length === 0 ? (
              <EmptyState title="No documents" />
            ) : (
              <SimpleTable
                head={["Document", "Category", "Version", "Status"]}
                rows={vendorDocs.map((d) => [
                  d.name,
                  d.category,
                  d.version,
                  <StatusBadge key={d.id} status={d.status} label={d.status.replace("_", " ")} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="invoices" className="pt-4">
            {vendorInvoices.length === 0 ? (
              <EmptyState title="No invoices" />
            ) : (
              <SimpleTable
                head={["Invoice", "PO", "Amount", "Status"]}
                rows={vendorInvoices.map((i) => [
                  i.id,
                  i.po,
                  formatMoney(i.amount, i.currency),
                  <StatusBadge key={i.id} status={i.status} label={INVOICE_STATUS_LABEL[i.status]} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="payments" className="pt-4">
            {vendorPayments.length === 0 ? (
              <EmptyState title="No payments" />
            ) : (
              <SimpleTable
                head={["Reference", "Invoice", "Amount", "Status"]}
                rows={vendorPayments.map((p) => [
                  p.id,
                  p.invoice,
                  formatMoney(p.amount, p.currency),
                  <StatusBadge key={p.id} status={p.status.toLowerCase()} label={p.status} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="pos" className="pt-4">
            {vendorPOs.length === 0 ? (
              <EmptyState title="No purchase orders" />
            ) : (
              <SimpleTable
                head={["PO", "Amount", "Status", "Visible", "Acknowledged"]}
                rows={vendorPOs.map((p) => [
                  p.id,
                  formatMoney(p.amount, p.currency),
                  p.status,
                  <StatusBadge key={p.id} tone={p.visible ? "success" : "neutral"} label={p.visible ? "Shared" : "Hidden"} />,
                  p.acknowledged ? p.ackDate : "—",
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="contracts" className="pt-4">
            {vendorContracts.length === 0 ? (
              <EmptyState title="No contracts" />
            ) : (
              <SimpleTable
                head={["Contract", "Effective", "Expiry", "Visible"]}
                rows={vendorContracts.map((c) => [
                  c.title,
                  c.effective,
                  c.expiry,
                  <StatusBadge key={c.id} tone={c.visible ? "success" : "neutral"} label={c.visible ? "Shared" : "Hidden"} />,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="activity" className="pt-4">
            <ul className="grid gap-2">
              {vendorAudit.length === 0 ? (
                <EmptyState title="No recent activity" />
              ) : (
                vendorAudit.map((a) => (
                  <li key={a.id} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{a.action}</span>
                      <span className="text-xs text-muted-foreground">{a.timestamp}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.actor} · {a.resource}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </TabsContent>

          <TabsContent value="sessions" className="pt-4">
            {vendorSessions.length === 0 ? (
              <EmptyState title="No active sessions" />
            ) : (
              <SimpleTable
                head={["User", "Device", "IP", "Status", ""]}
                rows={vendorSessions.map((s) => [
                  s.user,
                  `${s.device} · ${s.browser}`,
                  s.ip,
                  <StatusBadge key={s.id} status={s.status} label={s.status} />,
                  <Button key={s.id + "b"} size="xs" variant="ghost" onClick={() => toast.success("Session revoked")}>
                    Revoke
                  </Button>,
                ])}
              />
            )}
          </TabsContent>

          <TabsContent value="security" className="pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <SecurityRow label="Multi-factor auth" value="Enforced for admins" tone="success" />
              <SecurityRow label="Failed attempts (24h)" value="1" tone="neutral" />
              <SecurityRow label="Account lockout" value="After 5 attempts" tone="neutral" />
              <SecurityRow label="Session timeout" value="30 minutes" tone="neutral" />
              <SecurityRow label="Password last changed" value="42 days ago" tone="warning" />
              <SecurityRow label="Trusted domains" value={vendor.email.split("@")[1]} tone="info" />
            </div>
          </TabsContent>

          <TabsContent value="audit" className="pt-4">
            {vendorAudit.length === 0 ? (
              <EmptyState title="No audit history" />
            ) : (
              <SimpleTable
                head={["Time", "Actor", "Action", "Result"]}
                rows={vendorAudit.map((a) => [
                  a.timestamp,
                  a.actor,
                  a.action,
                  <StatusBadge key={a.id} tone={a.result === "success" ? "success" : "danger"} label={a.result} />,
                ])}
              />
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function MetricBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function SecurityRow({ label, value, tone }: { label: string; value: string; tone: any }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <StatusBadge tone={tone} label={value} />
    </div>
  )
}

function SimpleTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            {head.map((h, i) => (
              <TableHead key={i} className="px-3 text-xs">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className="px-3 text-sm">
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
