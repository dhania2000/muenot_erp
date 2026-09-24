"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CheckCircle2, XCircle, Inbox } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { FormDefinition, SubmissionStatus } from "@/lib/custom-forms/model"
import { submissionStatusLabel, visibleFields } from "@/lib/custom-forms/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type RoleOpt = { role: string; label: string }

type Submission = {
  id: number
  formId: number
  formVersion: number
  status: SubmissionStatus
  values: Record<string, unknown>
  submittedBy: number | null
  submittedAt: string | null
  reviewedBy: number | null
  reviewedAt: string | null
  reviewNote: string
  createdAt: string
}

type Resp = { form: FormDefinition; submissions: Submission[] }

const STATUS_STYLE: Record<SubmissionStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-blue-600 hover:bg-blue-600",
  pending: "bg-amber-500 hover:bg-amber-500",
  approved: "bg-emerald-600 hover:bg-emerald-600",
  rejected: "bg-destructive hover:bg-destructive",
}

export function SubmissionsDialog({
  form,
  roles,
  onClose,
}: {
  form: FormDefinition
  roles: RoleOpt[]
  onClose: () => void
}) {
  const { data, isLoading, mutate } = useSWR<Resp>(
    form.id ? `/api/admin/custom-forms/${form.id}/submissions` : null,
    fetcher,
  )
  const [note, setNote] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)

  const submissions = useMemo(() => data?.submissions ?? [], [data])
  const labelByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of form.sections) for (const f of s.fields) m.set(f.key, f.label)
    return m
  }, [form])

  async function review(id: number, decision: "approve" | "reject") {
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/custom-forms/submissions/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: note[id] ?? "" }),
      })
      if (res.ok) await mutate()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0">
        <div className="flex max-h-[90vh] flex-col">
          <DialogHeader className="border-b p-6 pb-4">
            <DialogTitle>{form.title} — submissions</DialogTitle>
            <DialogDescription>
              {form.approval.enabled
                ? "This form requires approval. Pending submissions can be approved or rejected below."
                : "This form does not require approval; submissions are accepted immediately."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 w-full" />
                ))}
              </div>
            ) : submissions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Inbox className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No submissions yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Responses to this form will appear here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {submissions.map((sub) => (
                  <div key={sub.id} className="rounded-lg border">
                    <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">#{sub.id}</span>
                        <Badge className={STATUS_STYLE[sub.status]}>
                          {submissionStatusLabel(sub.status)}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">{sub.submittedAt ?? sub.createdAt}</span>
                    </div>

                    <dl className="grid gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
                      {Object.entries(sub.values).length === 0 ? (
                        <p className="text-sm text-muted-foreground">No values captured.</p>
                      ) : (
                        Object.entries(sub.values).map(([key, value]) => (
                          <div key={key} className="flex flex-col">
                            <dt className="text-xs font-medium text-muted-foreground">
                              {labelByKey.get(key) ?? key}
                            </dt>
                            <dd className="text-sm">{formatValue(value)}</dd>
                          </div>
                        ))
                      )}
                    </dl>

                    {sub.reviewNote && (
                      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                        Review note: {sub.reviewNote}
                      </p>
                    )}

                    {form.approval.enabled && sub.status === "pending" && (
                      <div className="flex flex-col gap-2 border-t p-4">
                        <Textarea
                          placeholder="Optional review note"
                          value={note[sub.id] ?? ""}
                          onChange={(e) => setNote((prev) => ({ ...prev, [sub.id]: e.target.value }))}
                          rows={2}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700"
                            disabled={busy === sub.id}
                            onClick={() => review(sub.id, "approve")}
                          >
                            <CheckCircle2 className="mr-1.5 h-4 w-4" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy === sub.id}
                            onClick={() => review(sub.id, "reject")}
                          >
                            <XCircle className="mr-1.5 h-4 w-4" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function formatValue(value: unknown): string {
  if (value == null) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(", ")
  if (typeof value === "object") {
    const o = value as { name?: string; url?: string }
    if (o.url) return o.name ?? o.url
    return JSON.stringify(value)
  }
  return String(value)
}
