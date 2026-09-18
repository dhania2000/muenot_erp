"use client"

import { useState } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { CheckCircle2, XCircle, Inbox, Clock, Building2, User, Layers } from "lucide-react"

type InboxRequest = {
  id: number
  moduleKey: string
  title: string | null
  amount: number | null
  department: string | null
  requesterRole: string | null
  legalEntityId: number | null
  status: "pending" | "approved" | "rejected" | "cancelled"
  currentLevel: number | null
  requestedByName: string | null
  createdAt: string
  myStepIds: number[]
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load")
    return r.json()
  })

function formatAmount(n: number | null) {
  if (n == null) return null
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n)
}

export function ApprovalsInbox() {
  const { data, error, isLoading, mutate } = useSWR<{ requests: InboxRequest[] }>("/api/approvals/inbox", fetcher)
  const [comments, setComments] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const requests = data?.requests ?? []

  async function act(requestId: number, action: "approve" | "reject") {
    setBusy(requestId)
    setActionError(null)
    try {
      const res = await fetch(`/api/approvals/requests/${requestId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, comment: comments[requestId]?.trim() || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? "Action failed")
      }
      setComments((c) => {
        const next = { ...c }
        delete next[requestId]
        return next
      })
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Inbox className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-xl font-semibold tracking-tight">Approval inbox</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Requests awaiting your decision. Levels clear in sequence; escalations and delegations are applied
          automatically.
        </p>
      </header>

      {actionError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 w-full animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load your inbox. Please try again.
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <CheckCircle2 className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">You&apos;re all caught up</p>
            <p className="text-sm text-muted-foreground">No approvals are waiting on you right now.</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-4">
          {requests.map((req) => {
            const amount = formatAmount(req.amount)
            const isBusy = busy === req.id
            return (
              <li key={req.id}>
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="text-base font-semibold">
                        {req.title || `${req.moduleKey} request #${req.id}`}
                      </CardTitle>
                      <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                        {req.moduleKey}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {req.currentLevel != null ? (
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3.5" aria-hidden /> Level {req.currentLevel}
                        </span>
                      ) : null}
                      {req.requestedByName ? (
                        <span className="inline-flex items-center gap-1">
                          <User className="size-3.5" aria-hidden /> {req.requestedByName}
                        </span>
                      ) : null}
                      {req.department ? (
                        <span className="inline-flex items-center gap-1">
                          <Building2 className="size-3.5" aria-hidden /> {req.department}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3.5" aria-hidden />
                        {new Date(req.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {amount ? (
                      <p className="text-sm">
                        <span className="text-muted-foreground">Amount: </span>
                        <span className="font-medium tabular-nums">{amount}</span>
                      </p>
                    ) : null}
                    <Textarea
                      value={comments[req.id] ?? ""}
                      onChange={(e) => setComments((c) => ({ ...c, [req.id]: e.target.value }))}
                      placeholder="Add a comment (optional)"
                      rows={2}
                      className="resize-none text-sm"
                      aria-label={`Comment for request ${req.id}`}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => act(req.id, "approve")} disabled={isBusy}>
                        <CheckCircle2 className="size-4" aria-hidden />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act(req.id, "reject")}
                        disabled={isBusy}
                        className="text-destructive hover:text-destructive"
                      >
                        <XCircle className="size-4" aria-hidden />
                        Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
