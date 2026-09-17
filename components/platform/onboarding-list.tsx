"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, ArrowRight, Trash2, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type OnboardingSummary = {
  id: number
  status: "draft" | "in_progress" | "completed" | "failed"
  currentStep: number
  companyName: string | null
  slug: string | null
  plan: string | null
  createdTenantId: number | null
  errorMessage: string | null
  updatedAt: string
}

const STATUS_META: Record<
  OnboardingSummary["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Draft", variant: "outline" },
  in_progress: { label: "In progress", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
}

const TOTAL_STEPS = 8

export function OnboardingList({ sessions, canManage }: { sessions: OnboardingSummary[]; canManage: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [pendingId, setPendingId] = useState<number | null>(null)

  async function startNew() {
    setBusy(true)
    try {
      const res = await fetch("/api/platform/onboarding", { method: "POST" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not start onboarding")
        return
      }
      router.push(`/platform/onboarding/${json.session.id}`)
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    setPendingId(id)
    try {
      const res = await fetch(`/api/platform/onboarding/${id}`, { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not delete onboarding")
        return
      }
      toast.success("Onboarding session removed")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={startNew} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Start onboarding
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No onboarding sessions yet. Start one to provision a new organization.
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const meta = STATUS_META[s.status]
                const rowBusy = pendingId === s.id
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Building2 className="size-4" />
                        </span>
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium">{s.companyName || "Untitled organization"}</span>
                          <span className="text-xs text-muted-foreground">{s.slug || "no slug yet"}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground">{s.plan || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.status === "completed"
                        ? "Provisioned"
                        : `Step ${Math.min(s.currentStep + 1, TOTAL_STEPS)} of ${TOTAL_STEPS}`}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                        {s.status === "failed" && s.errorMessage ? (
                          <span className="max-w-56 truncate text-xs text-destructive" title={s.errorMessage}>
                            {s.errorMessage}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant={s.status === "completed" ? "outline" : "secondary"}
                          onClick={() => router.push(`/platform/onboarding/${s.id}`)}
                        >
                          {s.status === "completed" ? "View" : s.status === "failed" ? "Resume" : "Continue"}
                          <ArrowRight className="size-3.5" />
                        </Button>
                        {canManage && s.status !== "completed" ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => remove(s.id)}
                            disabled={rowBusy}
                          >
                            {rowBusy ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                            <span className="sr-only">Delete onboarding</span>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
