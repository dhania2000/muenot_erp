"use client"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import {
  StatusBadge,
  RowActions,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  EmptyState,
} from "@/components/vendor-portal-admin/shared"
import {
  type Vendor,
  PORTAL_USERS,
  PORTAL_INVOICES,
  PORTAL_POS,
  BANK_DETAILS,
  COMPLIANCE_DOCS,
  VENDOR_DOCUMENTS,
  ONBOARDING_STAGES,
  PORTAL_STATUS_LABEL,
} from "@/lib/vendor-portal/admin-data"
import { CheckCircle2, Circle, Ban, LogIn, KeyRound, Mail } from "lucide-react"

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  )
}

export function VendorDetailSheet({
  vendor,
  open,
  onOpenChange,
}: {
  vendor: Vendor | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  if (!vendor) return null

  const users = PORTAL_USERS.filter((u) => u.vendorId === vendor.id)
  const invoices = PORTAL_INVOICES.filter((i) => i.vendor === vendor.name || i.vendor === vendor.name.split(" ").slice(0, 2).join(" "))
  const pos = PORTAL_POS.filter((p) => vendor.name.startsWith(p.vendor) || p.vendor === vendor.name)
  const bank = BANK_DETAILS.filter((b) => vendor.name.startsWith(b.vendor))
  const compliance = COMPLIANCE_DOCS.filter((c) => vendor.name.startsWith(c.vendor))
  const docs = VENDOR_DOCUMENTS.filter((d) => vendor.name.startsWith(d.vendor))

  // Derive onboarding stage progress from status.
  const completedStages =
    vendor.onboarding === "complete"
      ? ONBOARDING_STAGES.length
      : vendor.onboarding === "under-review"
        ? 7
        : vendor.onboarding === "in-progress"
          ? 4
          : vendor.onboarding === "incomplete"
            ? 3
            : 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <SheetTitle className="flex items-center gap-2">
                {vendor.name}
                <StatusBadge status={vendor.portalStatus} label={PORTAL_STATUS_LABEL[vendor.portalStatus]} />
              </SheetTitle>
              <SheetDescription>
                {vendor.code} · {vendor.type} · {vendor.country}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Tabs defaultValue="overview">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="finance">Finance</TabsTrigger>
              <TabsTrigger value="bank">Bank</TabsTrigger>
              <TabsTrigger value="compliance">Compliance</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="pt-4">
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Primary contact" value={vendor.contact} />
                <Field label="Contact email" value={vendor.contactEmail} />
                <Field label="Category" value={vendor.category} />
                <Field label="Payment terms" value={vendor.paymentTerms} />
                <Field label="Currency" value={vendor.currency} />
                <Field label="Access profile" value={vendor.accessProfile} />
                <Field label="Portal users" value={vendor.users} />
                <Field label="Last login" value={fmtDateTime(vendor.lastLogin)} />
                <Field label="Created" value={fmtDate(vendor.createdDate)} />
                <Field label="Approved" value={fmtDate(vendor.approvedDate)} />
                <Field label="Onboarding" value={<StatusBadge status={vendor.onboarding} />} />
                <Field label="Compliance" value={<StatusBadge status={vendor.compliance} />} />
              </dl>
            </TabsContent>

            <TabsContent value="onboarding" className="pt-4">
              <ol className="grid gap-0">
                {ONBOARDING_STAGES.map((stage, i) => {
                  const done = i < completedStages
                  const current = i === completedStages
                  return (
                    <li key={stage} className="flex items-center gap-3 py-1.5">
                      {done ? (
                        <CheckCircle2 className="size-4 text-emerald-500" />
                      ) : current ? (
                        <Circle className="size-4 text-amber-500" />
                      ) : (
                        <Circle className="size-4 text-muted-foreground/40" />
                      )}
                      <span className={done ? "text-sm" : "text-sm text-muted-foreground"}>{stage}</span>
                      {current ? <StatusBadge status="in-progress" /> : null}
                    </li>
                  )
                })}
              </ol>
            </TabsContent>

            <TabsContent value="users" className="pt-4">
              {users.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="grid gap-0.5">
                            <span className="font-medium">{u.name}</span>
                            <span className="text-xs text-muted-foreground">{u.email}</span>
                          </div>
                        </TableCell>
                        <TableCell>{u.role}</TableCell>
                        <TableCell>
                          <StatusBadge status={u.status} />
                        </TableCell>
                        <TableCell>
                          <RowActions
                            actions={[
                              { label: "Reset password", onSelect: () => toast.success(`Reset link sent to ${u.email}`) },
                              { label: "Force logout" },
                              { label: "Impersonate (read-only)" },
                              { label: u.status === "suspended" ? "Reactivate" : "Suspend", destructive: u.status !== "suspended", separatorBefore: true },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="No portal users yet" description="This vendor has not accepted an invitation." />
              )}
            </TabsContent>

            <TabsContent value="finance" className="pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Purchase orders</p>
              {pos.length ? (
                <Table className="mb-5">
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pos.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.id}</TableCell>
                        <TableCell>{fmtMoney(p.amount, p.currency)}</TableCell>
                        <TableCell>
                          <StatusBadge status={p.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="mb-5 text-sm text-muted-foreground">No purchase orders shared.</p>
              )}
              <p className="mb-2 text-xs font-medium text-muted-foreground">Invoices</p>
              {invoices.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="font-medium">{i.id}</TableCell>
                        <TableCell>{fmtMoney(i.amount, i.currency)}</TableCell>
                        <TableCell>
                          <StatusBadge status={i.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No invoices submitted.</p>
              )}
            </TabsContent>

            <TabsContent value="bank" className="pt-4">
              {bank.length ? (
                <div className="grid gap-3">
                  {bank.map((b) => (
                    <div key={b.id} className="rounded-lg border border-border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-medium">{b.bank}</span>
                        <StatusBadge status={b.status} />
                      </div>
                      <dl className="grid grid-cols-2 gap-3">
                        <Field label="Account holder" value={b.holder} />
                        <Field label="Account" value={b.maskedAccount} />
                        <Field label="IFSC / SWIFT" value={b.ifscSwift} />
                        <Field label="Currency" value={b.currency} />
                      </dl>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No bank details" />
              )}
            </TabsContent>

            <TabsContent value="compliance" className="pt-4">
              {compliance.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {compliance.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.document}</TableCell>
                        <TableCell className="font-mono text-xs">{c.number}</TableCell>
                        <TableCell>{c.expiry}</TableCell>
                        <TableCell>
                          <StatusBadge status={c.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="No compliance records" />
              )}
            </TabsContent>

            <TabsContent value="documents" className="pt-4">
              {docs.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {docs.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.name}</TableCell>
                        <TableCell>{d.category}</TableCell>
                        <TableCell>{d.version}</TableCell>
                        <TableCell>
                          <StatusBadge status={d.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="No documents uploaded" />
              )}
            </TabsContent>
          </Tabs>
        </div>

        <SheetFooter className="flex-row flex-wrap gap-2 border-t border-border">
          <Button size="sm" variant="outline" onClick={() => toast.success("Impersonation session started (read-only)")}>
            <LogIn data-icon="inline-start" className="size-4" /> Login as vendor
          </Button>
          <Button size="sm" variant="outline" onClick={() => toast.success("Password reset emailed")}>
            <KeyRound data-icon="inline-start" className="size-4" /> Reset password
          </Button>
          <Button size="sm" variant="outline" onClick={() => toast.success("Message sent to vendor")}>
            <Mail data-icon="inline-start" className="size-4" /> Message
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => toast.success(`${vendor.name} suspended`)}
          >
            <Ban data-icon="inline-start" className="size-4" /> Suspend
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
