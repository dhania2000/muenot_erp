"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { ArrowRight, ShieldAlert } from "lucide-react"
import {
  SectionHeader,
  StatusBadge,
  RowActions,
  Panel,
  EmptyState,
  fmtDate,
} from "@/components/vendor-portal-admin/shared"
import { BANK_DETAILS, BANK_CHANGE_REQUESTS } from "@/lib/vendor-portal/admin-data"

export function BankSection() {
  const [tab, setTab] = useState("accounts")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Bank Details Management"
        description="Verify vendor settlement accounts and review change requests. Bank changes require dual-control approval."
      />

      <Panel className="flex items-center gap-2 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
        <ShieldAlert className="size-4 shrink-0" />
        Bank detail changes are high-risk. All updates are masked, logged in the audit trail and require verification before payments resume.
      </Panel>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="accounts">Bank Accounts</TabsTrigger>
          <TabsTrigger value="changes">
            Change Requests
            {BANK_CHANGE_REQUESTS.length ? (
              <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                {BANK_CHANGE_REQUESTS.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="pt-4">
          <Panel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>IFSC / SWIFT</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {BANK_DETAILS.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{b.vendor}</span>
                        <span className="text-xs text-muted-foreground">{b.holder}</span>
                      </div>
                    </TableCell>
                    <TableCell>{b.bank}</TableCell>
                    <TableCell className="font-mono text-xs">{b.maskedAccount}</TableCell>
                    <TableCell className="font-mono text-xs">{b.ifscSwift}</TableCell>
                    <TableCell>{b.currency}</TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(b.updated)}</TableCell>
                    <TableCell>
                      <RowActions
                        label="Bank account"
                        actions={[
                          { label: "View full details" },
                          { label: "Mark verified", onSelect: () => toast.success("Bank account verified") },
                          { label: "Request document" },
                          { label: "Reject", destructive: true, separatorBefore: true },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </TabsContent>

        <TabsContent value="changes" className="pt-4">
          {BANK_CHANGE_REQUESTS.length ? (
            <div className="grid gap-3">
              {BANK_CHANGE_REQUESTS.map((r) => (
                <Card key={r.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm">
                        {r.vendor}{" "}
                        <span className="font-normal text-muted-foreground">· {r.id}</span>
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={r.verification === "verified" ? "verified" : r.verification === "pending" ? "pending" : "not-started"} label={`Verification: ${r.verification.replace("-", " ")}`} />
                        <StatusBadge status={r.status} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <div className="grid gap-0.5">
                        <span className="text-xs text-muted-foreground">Current</span>
                        <span className="font-mono">{r.oldSummary}</span>
                      </div>
                      <ArrowRight className="size-4 text-muted-foreground" />
                      <div className="grid gap-0.5">
                        <span className="text-xs text-muted-foreground">Requested</span>
                        <span className="font-mono font-medium">{r.newSummary}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        Requested by {r.requestedBy} on {fmtDate(r.requested)} · Reviewer {r.reviewer ?? "Unassigned"}
                      </span>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => toast.success("Verification requested from vendor")}>
                          Request verification
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => toast.success("Change request rejected")}>
                          Reject
                        </Button>
                        <Button size="sm" onClick={() => toast.success("Bank change approved and applied")}>
                          Approve
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState title="No pending change requests" description="Bank detail change requests from vendors will appear here." />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
