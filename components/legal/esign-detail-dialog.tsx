"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Send,
  Download,
  Ban,
  RotateCw,
  PenTool,
  Mail,
  CalendarClock,
  LayoutTemplate,
  Loader2,
  FileSignature,
  Clock,
  CheckCircle2,
  XCircle,
  Eye,
} from "lucide-react"
import { EsignStatusBadge, SignerStatusBadge } from "@/components/legal/esign-status-badge"
import {
  signerTypeLabel,
  type EsignRequest,
  type EsignEvent,
} from "@/lib/legal-esign-shared"

const OPEN_STATUSES = ["Sent", "Viewed", "Partially Signed"]

export function EsignDetailDialog({
  requestId,
  canManage,
  onClose,
  onChanged,
  onPrepareFields,
}: {
  requestId: number
  canManage: boolean
  onClose: () => void
  onChanged: () => void
  onPrepareFields: (req: EsignRequest) => void
}) {
  const { data, mutate, isLoading } = useSWR<{ request: EsignRequest }>(
    `/api/legal/esign/${requestId}`,
    fetcher,
  )
  const req = data?.request
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | "cancel" | "send" | "delete">(null)
  const [cancelReason, setCancelReason] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [emailTo, setEmailTo] = useState("")

  function refresh() {
    mutate()
    onChanged()
  }

  async function act(key: string, url: string, body?: unknown, method = "POST") {
    setBusy(key)
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        refresh()
        return d
      }
      toast.error(d.error || "Action failed")
      return null
    } finally {
      setBusy(null)
    }
  }

  const isDraft = req?.status === "Draft"
  const isOpen = req ? OPEN_STATUSES.includes(req.status) : false
  const isCompleted = req?.status === "Completed"
  const fieldCount = (req?.signers || []).reduce((n, s) => n + (s.fields?.length || 0), 0)

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-3xl">
        {isLoading || !req ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="mr-1">{req.title}</DialogTitle>
                <EsignStatusBadge status={req.status} />
              </div>
              <DialogDescription>
                {req.request_uid}
                {req.contract_reference ? ` · ${req.contract_reference}` : ""} ·{" "}
                {req.signing_type === "sequential" ? "Sequential signing" : "Parallel signing"}
              </DialogDescription>
            </DialogHeader>

            {/* Action bar */}
            {canManage && (
              <div className="flex flex-wrap gap-2 border-y py-3">
                {isDraft && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => onPrepareFields(req)}>
                      <LayoutTemplate data-icon="inline-start" /> Place fields ({fieldCount})
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setConfirm("send")}
                      disabled={busy !== null || (req.signers || []).length === 0}
                    >
                      <Send data-icon="inline-start" /> Send for signing
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-rose-600 hover:text-rose-700"
                      onClick={() => setConfirm("delete")}
                    >
                      Delete draft
                    </Button>
                  </>
                )}
                {isOpen && (
                  <Button size="sm" variant="outline" onClick={() => setConfirm("cancel")} disabled={busy !== null}>
                    <Ban data-icon="inline-start" /> Cancel request
                  </Button>
                )}
                <Button size="sm" variant="outline" asChild>
                  <a href={`/api/legal/esign/${req.id}/pdf`} target="_blank" rel="noreferrer">
                    <Download data-icon="inline-start" /> Original PDF
                  </a>
                </Button>
                {isCompleted && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={`/api/legal/esign/${req.id}/pdf?signed=1`} target="_blank" rel="noreferrer">
                      <FileSignature data-icon="inline-start" /> Signed PDF
                    </a>
                  </Button>
                )}
              </div>
            )}

            <Tabs defaultValue="signers">
              <TabsList>
                <TabsTrigger value="signers">Signers</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                {(isOpen || isCompleted) && canManage && <TabsTrigger value="tools">Tools</TabsTrigger>}
              </TabsList>

              {/* Signers */}
              <TabsContent value="signers" className="flex flex-col gap-3 pt-2">
                {req.message && (
                  <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">{req.message}</p>
                )}
                {(req.signers || []).map((s) => {
                  const pending = ["Pending", "Sent", "Viewed"].includes(s.status)
                  const canInternalSign =
                    canManage &&
                    isOpen &&
                    pending &&
                    (s.signer_type === "authorized_signatory" || s.signer_type === "employee")
                  return (
                    <div key={s.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                              {s.signing_order}
                            </span>
                            <span className="font-medium">{s.name}</span>
                            <SignerStatusBadge status={s.status} />
                          </div>
                          <div className="mt-1 pl-8 text-sm text-muted-foreground">
                            {s.email}
                            {s.mobile ? ` · ${s.mobile}` : ""} · {signerTypeLabel(s.signer_type)}
                            {s.role ? ` · ${s.role}` : ""}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-8 text-xs text-muted-foreground">
                            {s.viewed_at && (
                              <span className="inline-flex items-center gap-1">
                                <Eye className="size-3" /> Viewed
                              </span>
                            )}
                            {s.signed_at && (
                              <span className="inline-flex items-center gap-1 text-emerald-600">
                                <CheckCircle2 className="size-3" /> Signed {fmt(s.signed_at)}
                              </span>
                            )}
                            {s.rejected_at && (
                              <span className="inline-flex items-center gap-1 text-rose-600">
                                <XCircle className="size-3" /> Rejected — {s.reject_reason || "no reason"}
                              </span>
                            )}
                            <span>{(s.fields?.length || 0)} field(s)</span>
                          </div>
                        </div>
                        {canManage && (isOpen || isDraft) && (
                          <div className="flex shrink-0 gap-1.5">
                            {isOpen && pending && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => act(`resend-${s.id}`, `/api/legal/esign/${req.id}/resend`, { signerId: s.id })}
                                disabled={busy !== null}
                                title="Resend signing link"
                              >
                                {busy === `resend-${s.id}` ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <RotateCw className="size-4" />
                                )}
                              </Button>
                            )}
                            {canInternalSign && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  act(`sign-${s.id}`, `/api/legal/esign/${req.id}/sign-internal`, { signerId: s.id })
                                }
                                disabled={busy !== null}
                              >
                                {busy === `sign-${s.id}` ? (
                                  <Loader2 data-icon="inline-start" className="animate-spin" />
                                ) : (
                                  <PenTool data-icon="inline-start" />
                                )}
                                Sign now
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                {(req.signers || []).length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">No signers added yet.</p>
                )}
              </TabsContent>

              {/* History */}
              <TabsContent value="history" className="pt-2">
                <HistoryTimeline requestId={req.id} />
              </TabsContent>

              {/* Tools */}
              {(isOpen || isCompleted) && canManage && (
                <TabsContent value="tools" className="flex flex-col gap-5 pt-3">
                  {isOpen && (
                    <div className="flex flex-col gap-2">
                      <Label className="flex items-center gap-1.5">
                        <CalendarClock className="size-4" /> Extend due date
                      </Label>
                      <div className="flex gap-2">
                        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                        <Button
                          variant="outline"
                          disabled={!dueDate || busy !== null}
                          onClick={async () => {
                            const d = await act("extend", `/api/legal/esign/${req.id}/extend`, { dueDate })
                            if (d) {
                              toast.success("Due date extended")
                              setDueDate("")
                            }
                          }}
                        >
                          Extend
                        </Button>
                      </div>
                      {req.due_date && (
                        <p className="text-xs text-muted-foreground">Current due date: {fmt(req.due_date)}</p>
                      )}
                    </div>
                  )}
                  {isCompleted && (
                    <div className="flex flex-col gap-2">
                      <Label className="flex items-center gap-1.5">
                        <Mail className="size-4" /> Email the signed copy
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          placeholder="recipient@example.com"
                          value={emailTo}
                          onChange={(e) => setEmailTo(e.target.value)}
                        />
                        <Button
                          variant="outline"
                          disabled={!/.+@.+\..+/.test(emailTo) || busy !== null}
                          onClick={async () => {
                            const d = await act("email", `/api/legal/esign/${req.id}/email`, { to: emailTo })
                            if (d) {
                              toast.success("Signed copy emailed")
                              setEmailTo("")
                            }
                          }}
                        >
                          Send
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>
              )}
            </Tabs>
          </>
        )}
      </DialogContent>

      {/* Confirmations */}
      <AlertDialog open={confirm === "send"} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this request for signing?</AlertDialogTitle>
            <AlertDialogDescription>
              {fieldCount === 0
                ? "No signature fields have been placed. Signers will use a default signature block. You can place fields first for precise positioning."
                : "Signing links will be emailed to the signers. Sequential requests notify the first signer only."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setConfirm(null)
                const d = await act("send", `/api/legal/esign/${requestId}/send`)
                if (d) toast.success("Request sent for signing")
              }}
            >
              Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "cancel"} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this signature request?</AlertDialogTitle>
            <AlertDialogDescription>
              All pending signing links stop working immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-1">
            <Textarea
              placeholder="Reason (optional, shared internally)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={2}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep active</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={async () => {
                setConfirm(null)
                const d = await act("cancel", `/api/legal/esign/${requestId}/cancel`, { reason: cancelReason || null })
                if (d) {
                  toast.success("Request cancelled")
                  setCancelReason("")
                }
              }}
            >
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "delete"} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>The draft and its field layout will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={async () => {
                setConfirm(null)
                const d = await act("delete", `/api/legal/esign/${requestId}`, undefined, "DELETE")
                if (d !== null) {
                  toast.success("Draft deleted")
                  onChanged()
                  onClose()
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function HistoryTimeline({ requestId }: { requestId: number }) {
  const { data, isLoading } = useSWR<{ events: EsignEvent[] }>(`/api/legal/esign/${requestId}/events`, fetcher)
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading history…
      </div>
    )
  }
  const events = data?.events || []
  if (events.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
  }
  return (
    <ol className="relative flex flex-col gap-4 py-2 pl-6">
      <span className="absolute inset-y-2 left-[7px] w-px bg-border" aria-hidden />
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[22px] top-1 flex size-3.5 items-center justify-center rounded-full border-2 border-primary bg-background">
            <Clock className="size-2 text-primary" />
          </span>
          <div className="text-sm font-medium">{e.summary}</div>
          <div className="text-xs text-muted-foreground">
            {fmt(e.created_at)}
            {e.actor_name ? ` · ${e.actor_name}` : ""}
          </div>
        </li>
      ))}
    </ol>
  )
}

function fmt(v: string | null | undefined): string {
  if (!v) return ""
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
