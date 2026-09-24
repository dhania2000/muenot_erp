"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Landmark,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ShieldQuestion,
  FileCheck2,
  FileText,
  ShieldCheck,
  Eye,
  RefreshCw,
  Archive,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import {
  BANK_DETAILS,
  BANK_CHANGE_REQUESTS,
  COMPLIANCE_DOCS,
  VENDOR_DOCUMENTS,
} from "./mock-data"

const BANK_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor" },
  { key: "holder", header: "Account Holder" },
  { key: "bank", header: "Bank" },
  { key: "account", header: "Account" },
  { key: "ifsc", header: "IFSC/SWIFT" },
  { key: "iban", header: "IBAN" },
  { key: "currency", header: "Currency" },
  { key: "status", header: "Verification" },
  { key: "actions", header: "" },
]

const COMPLIANCE_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor" },
  { key: "document", header: "Document" },
  { key: "type", header: "Type" },
  { key: "number", header: "Number" },
  { key: "issued", header: "Issued" },
  { key: "expiry", header: "Expiry" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

const DOC_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor" },
  { key: "name", header: "Document" },
  { key: "category", header: "Category" },
  { key: "version", header: "Version" },
  { key: "uploaded", header: "Uploaded" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

export function BankComplianceSection() {
  const [scope, setScope] = useState<"bank" | "changes" | "compliance" | "documents">("bank")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Bank, Tax & Compliance"
        description="Securely administer vendor bank details, review high-risk bank change requests, and verify tax and compliance documents."
        icon={Landmark}
      />

      <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="bank">
            <Landmark className="size-4" /> Bank Details
          </TabsTrigger>
          <TabsTrigger value="changes">
            <ShieldQuestion className="size-4" /> Change Requests
          </TabsTrigger>
          <TabsTrigger value="compliance">
            <ShieldCheck className="size-4" /> Tax & Compliance
          </TabsTrigger>
          <TabsTrigger value="documents">
            <FileText className="size-4" /> Documents
          </TabsTrigger>
        </TabsList>

        {/* Bank details */}
        <TabsContent value="bank" className="grid gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" />
            Sensitive values are masked. Full account numbers are only revealed to authorized finance reviewers.
          </div>
          <AdminTable
            columns={BANK_COLUMNS}
            rows={BANK_DETAILS}
            empty={<EmptyState icon={Landmark} title="No bank details" />}
            render={(b, key) => {
              switch (key) {
                case "vendor":
                  return <span className="font-medium">{b.vendor}</span>
                case "holder":
                  return <span className="text-muted-foreground">{b.holder}</span>
                case "bank":
                  return b.bank
                case "account":
                  return <span className="font-mono text-xs">{b.account}</span>
                case "ifsc":
                  return <span className="font-mono text-xs">{b.ifsc}</span>
                case "iban":
                  return <span className="font-mono text-xs">{b.iban ?? "—"}</span>
                case "currency":
                  return b.currency
                case "status":
                  return <StatusBadge status={b.status} label={b.status.replace("_", " ")} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Bank details verified")}>
                        <CheckCircle2 className="size-3.5" /> Approve
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Correction requested")}>
                        Request fix
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        {/* Bank change requests */}
        <TabsContent value="changes" className="grid gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              <strong>High-risk changes.</strong> Bank detail changes can redirect payments. Verify the requester and
              supporting documents before approving.
            </span>
          </div>
          {BANK_CHANGE_REQUESTS.length === 0 ? (
            <EmptyState icon={ShieldQuestion} title="No change requests" />
          ) : (
            <div className="grid gap-3">
              {BANK_CHANGE_REQUESTS.map((r) => (
                <div
                  key={r.id}
                  className="grid gap-3 rounded-xl border border-border bg-card p-4 lg:grid-cols-[1fr_auto] lg:items-center"
                >
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.vendor}</span>
                      <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                      <StatusBadge status={r.status} label={r.status} />
                      <StatusBadge status={r.verification} label={`Verification: ${r.verification}`} />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-muted/30 p-2.5">
                        <p className="text-xs text-muted-foreground">Current</p>
                        <p className="font-mono text-sm">{r.oldSummary}</p>
                      </div>
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                        <p className="text-xs text-amber-700 dark:text-amber-300">Requested</p>
                        <p className="font-mono text-sm">{r.newSummary}</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Requested by {r.requestedBy} on {r.requested} · Reviewer {r.reviewer ?? "Unassigned"}
                    </p>
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex flex-wrap gap-1.5 lg:flex-col">
                      <Button size="xs" onClick={() => toast.success("Change approved")}>
                        <CheckCircle2 className="size-3.5" /> Approve
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => toast.success("Verification requested")}>
                        <ShieldQuestion className="size-3.5" /> Request Verification
                      </Button>
                      <Button size="xs" variant="destructive" onClick={() => toast.success("Change rejected")}>
                        <XCircle className="size-3.5" /> Reject
                      </Button>
                    </div>
                  ) : (
                    <StatusBadge status={r.status} label={r.status} />
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Tax & compliance */}
        <TabsContent value="compliance" className="grid gap-3">
          <AdminTable
            columns={COMPLIANCE_COLUMNS}
            rows={COMPLIANCE_DOCS}
            empty={<EmptyState icon={ShieldCheck} title="No compliance records" />}
            render={(c, key) => {
              switch (key) {
                case "vendor":
                  return <span className="font-medium">{c.vendor}</span>
                case "document":
                  return c.document
                case "type":
                  return <span className="text-muted-foreground">{c.type}</span>
                case "number":
                  return <span className="font-mono text-xs">{c.number}</span>
                case "issued":
                  return <span className="text-muted-foreground">{c.issued}</span>
                case "expiry":
                  return <span className="text-muted-foreground">{c.expiry}</span>
                case "status":
                  return <StatusBadge status={c.status} label={c.status} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Document verified")}>
                        <FileCheck2 className="size-3.5" /> Verify
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        {/* Documents */}
        <TabsContent value="documents" className="grid gap-3">
          <AdminTable
            columns={DOC_COLUMNS}
            rows={VENDOR_DOCUMENTS}
            empty={<EmptyState icon={FileText} title="No documents" />}
            render={(d, key) => {
              switch (key) {
                case "vendor":
                  return <span className="font-medium">{d.vendor}</span>
                case "name":
                  return d.name
                case "category":
                  return <span className="text-muted-foreground">{d.category}</span>
                case "version":
                  return d.version
                case "uploaded":
                  return <span className="text-muted-foreground">{d.uploaded}</span>
                case "status":
                  return <StatusBadge status={d.status} label={d.status.replace("_", " ")} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Opening document")}>
                        <Eye className="size-3.5" /> View
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Document verified")}>
                        <CheckCircle2 className="size-3.5" /> Verify
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("New version requested")}>
                        <RefreshCw className="size-3.5" /> New version
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Document archived")}>
                        <Archive className="size-3.5" /> Archive
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
