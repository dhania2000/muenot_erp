"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"

// -----------------------------------------------------------------------------
// SPEC 12 admin console. Left: toggle which high-risk operations require a
// second person. Right: the audit trail of captured changes and where each one
// sits in its approval lifecycle. Types mirror lib/maker-checker.ts exactly.
// -----------------------------------------------------------------------------

type Category = "vendor" | "banking" | "payment" | "accounting" | "tax" | "access" | "master-data"

type OperationGate = {
  key: string
  moduleKey: string
  label: string
  category: Category
  description: string
  defaultEnabled: boolean
  enabled: boolean
}

type ChangeStatus =
  | "pending"
  | "approved"
  | "applied"
  | "auto_applied"
  | "rejected"
  | "cancelled"
  | "failed"

type MakerCheckerChange = {
  id: number
  operationKey: string
  operationLabel: string
  moduleKey: string
  title: string | null
  amount: number | null
  entityRef: string | null
  status: ChangeStatus
  approvalRequestId: number | null
  makerId: number | null
  makerName: string | null
  applyError: string | null
  resultRef: string | null
  createdAt: string
  appliedAt: string | null
}

type ApiResponse = { operations: OperationGate[]; changes: MakerCheckerChange[] }

const CATEGORY_LABEL: Record<Category, string> = {
  vendor: "Vendor",
  banking: "Banking",
  payment: "Payment",
  accounting: "Accounting",
  tax: "Tax",
  access: "Access",
  "master-data": "Master data",
}

const STATUS_STYLES: Record<ChangeStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  applied: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  auto_applied: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  cancelled: "bg-muted text-muted-foreground",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  pending: "Awaiting checker",
  approved: "Approved",
  applied: "Applied",
  auto_applied: "Auto-applied",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Apply failed",
}

export function MakerCheckerManager() {
  const { data, isLoading, mutate } = useSWR<ApiResponse>("/api/admin/maker-checker", fetcher)
  const [saving, setSaving] = useState<string | null>(null)

  async function toggle(op: OperationGate, next: boolean) {
    setSaving(op.key)
    // Optimistic: reflect the switch immediately, roll back on failure.
    mutate(
      (curr) =>
        curr
          ? { ...curr, operations: curr.operations.map((o) => (o.key === op.key ? { ...o, enabled: next } : o)) }
          : curr,
      { revalidate: false },
    )
    try {
      const res = await fetch("/api/admin/maker-checker", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationKey: op.key, enabled: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Update failed")
      toast.success(`${op.label} ${next ? "now requires" : "no longer requires"} maker-checker`)
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
      mutate()
    } finally {
      setSaving(null)
    }
  }

  const operations = data?.operations ?? []
  const changes = data?.changes ?? []
  const pendingCount = changes.filter((c) => c.status === "pending").length

  return (
    <Tabs defaultValue="operations" className="flex flex-col gap-4">
      <TabsList className="self-start">
        <TabsTrigger value="operations">Governed operations</TabsTrigger>
        <TabsTrigger value="changes">
          Change log
          {pendingCount > 0 && (
            <Badge variant="secondary" className="ml-2">
              {pendingCount}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="operations" className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading operations…
          </div>
        ) : (
          operations.map((op) => (
            <Card key={op.key}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    {op.enabled ? (
                      <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
                    ) : (
                      <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />
                    )}
                    <CardTitle className="text-base">{op.label}</CardTitle>
                    <Badge variant="outline">{CATEGORY_LABEL[op.category]}</Badge>
                  </div>
                  <CardDescription className="max-w-2xl">{op.description}</CardDescription>
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  {saving === op.key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Switch
                    checked={op.enabled}
                    disabled={saving === op.key}
                    onCheckedChange={(v) => toggle(op, v)}
                    aria-label={`Require maker-checker for ${op.label}`}
                  />
                </div>
              </CardHeader>
            </Card>
          ))
        )}
      </TabsContent>

      <TabsContent value="changes">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Captured changes</CardTitle>
            <CardDescription>
              Every high-risk change is held here until a checker decides. Applied changes were released by a
              different person than the maker — segregation of duties is enforced by the approval engine.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading changes…
              </div>
            ) : changes.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">No changes have been captured yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operation</TableHead>
                      <TableHead>Detail</TableHead>
                      <TableHead>Maker</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changes.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.operationLabel}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.title || c.entityRef || "—"}
                          {c.applyError && <span className="block text-xs text-rose-600">{c.applyError}</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.makerName || `#${c.makerId ?? "—"}`}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.amount != null ? c.amount.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge className={STATUS_STYLES[c.status]} variant="secondary">
                            {STATUS_LABEL[c.status]}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
