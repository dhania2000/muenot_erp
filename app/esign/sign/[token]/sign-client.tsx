"use client"

import { useCallback, useEffect, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SignaturePad } from "@/components/legal/signature-pad"
import { EsignStatusBadge } from "@/components/legal/esign-status-badge"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { isInternalSignerType } from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Public, token-only signing page (Phases 33-37). No ERP session: the
// single-use token in the URL is the only credential. Everything here talks to
// /api/legal/esign/public/[token]/* which re-validates the token on every call.
// ---------------------------------------------------------------------------

type PublicSigner = {
  id: number
  name: string
  email: string
  role: string | null
  signer_type: string
  signatory_id: number | null
  fields: { field_type: string }[]
}
type PublicRequest = {
  id: number
  request_uid: string
  title: string
  message: string | null
  due_date: string | null
  status: string
  require_confirm: number
  contract_reference: string | null
}
type ProgressRow = { name: string; role: string | null; status: string }
type PublicResponse =
  | { ok: true; signer: PublicSigner; request: PublicRequest; progress: ProgressRow[] }
  | { ok: false; reason: "invalid" | "expired" | "used" | "closed" }

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function formatDue(d: string | null): string | null {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

const REASON_COPY: Record<string, { title: string; body: string; icon: typeof AlertTriangle }> = {
  invalid: {
    title: "This signing link is not valid",
    body: "The link may have been mistyped or superseded by a newer one. Please ask the sender for a fresh link.",
    icon: XCircle,
  },
  expired: {
    title: "This signing link has expired",
    body: "The signing window has closed. Please contact the sender to request a new link.",
    icon: Clock,
  },
  used: {
    title: "This document is already signed",
    body: "Our records show this document has already been completed. No further action is needed.",
    icon: CheckCircle2,
  },
  closed: {
    title: "This request is no longer open",
    body: "The signature request was cancelled, rejected or has expired and can no longer be signed.",
    icon: Lock,
  },
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-3.5">
          <span className="text-lg font-bold text-[#1e3a5f] dark:text-blue-300">Muenot</span>
          <span className="text-xs text-muted-foreground">Electronic Signature</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-emerald-600" />
            Secure signing
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t bg-background">
        <div className="mx-auto w-full max-w-5xl px-4 py-3 text-center text-xs text-muted-foreground">
          Powered by Muenot ERP · This link is unique to you — please do not forward it.
        </div>
      </footer>
    </div>
  )
}

function CenteredNotice({
  icon: Icon,
  tone,
  title,
  body,
}: {
  icon: typeof AlertTriangle
  tone: "red" | "green" | "slate"
  title: string
  body: string
}) {
  const toneClass =
    tone === "green"
      ? "bg-emerald-100 text-emerald-700"
      : tone === "red"
        ? "bg-rose-100 text-rose-700"
        : "bg-slate-100 text-slate-600"
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className={`flex size-14 items-center justify-center rounded-full ${toneClass}`}>
        <Icon className="size-7" />
      </span>
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      <p className="text-pretty text-sm text-muted-foreground">{body}</p>
    </div>
  )
}

export function SignClient({ token }: { token: string }) {
  const { data, error, isLoading, mutate } = useSWR<PublicResponse>(
    `/api/legal/esign/public/${token}`,
    fetcher,
    { revalidateOnFocus: false },
  )

  const [signatureData, setSignatureData] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [rejecting, setRejecting] = useState(false)
  const [finished, setFinished] = useState<null | "signed" | "rejected">(null)

  const isReady = data?.ok === true
  const signer = isReady ? data.signer : null
  const request = isReady ? data.request : null

  // Internal authorized signatories sign with their saved company signature.
  const usesSavedSignature = Boolean(signer?.signatory_id)
  const isInternal = signer ? isInternalSignerType(signer.signer_type) : false

  const requireConfirm = Boolean(request?.require_confirm)
  const canSubmit =
    (usesSavedSignature || Boolean(signatureData)) && (!requireConfirm || confirmed) && !submitting

  const submit = useCallback(async () => {
    if (!request) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/legal/esign/public/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: usesSavedSignature ? "saved" : "draw",
          imageData: usesSavedSignature ? null : signatureData,
          confirmed,
        }),
      })
      const json = await res.json()
      if (!json.ok) {
        toast.error(json.error || "Could not submit your signature.")
        // Token may have been burned or state changed — refresh.
        mutate()
        return
      }
      setFinished("signed")
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }, [request, token, usesSavedSignature, signatureData, confirmed, mutate])

  const reject = useCallback(async () => {
    if (!rejectReason.trim()) {
      toast.error("Please provide a reason.")
      return
    }
    setRejecting(true)
    try {
      const res = await fetch(`/api/legal/esign/public/${token}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      })
      const json = await res.json()
      if (!json.ok) {
        toast.error(json.error || "Could not decline the document.")
        return
      }
      setRejectOpen(false)
      setFinished("rejected")
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setRejecting(false)
    }
  }, [rejectReason, token])

  // ---- Terminal / non-ready states ----------------------------------------
  if (finished === "signed") {
    return (
      <Shell>
        <CenteredNotice
          icon={CheckCircle2}
          tone="green"
          title="Thank you — your document is signed"
          body="Your signature has been recorded. A copy of the completed document will be emailed to you once all parties have signed."
        />
      </Shell>
    )
  }
  if (finished === "rejected") {
    return (
      <Shell>
        <CenteredNotice
          icon={XCircle}
          tone="red"
          title="You have declined to sign"
          body="The sender has been notified of your decision. You may now close this window."
        />
      </Shell>
    )
  }

  if (isLoading) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-sm">Loading your document…</p>
        </div>
      </Shell>
    )
  }

  if (error || !data) {
    return (
      <Shell>
        <CenteredNotice
          icon={AlertTriangle}
          tone="red"
          title="Something went wrong"
          body="We couldn't load this document. Please check your connection and try again."
        />
      </Shell>
    )
  }

  if (!data.ok) {
    const copy = REASON_COPY[data.reason] ?? REASON_COPY.invalid
    return (
      <Shell>
        <CenteredNotice
          icon={copy.icon}
          tone={data.reason === "used" ? "green" : "red"}
          title={copy.title}
          body={copy.body}
        />
      </Shell>
    )
  }

  const due = formatDue(request!.due_date)

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Document panel */}
        <div className="flex flex-col gap-3 lg:order-1">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="size-4 text-[#1e3a5f] dark:text-blue-300" />
            <h1 className="text-lg font-semibold leading-tight text-balance">{request!.title}</h1>
            <EsignStatusBadge status={request!.status} className="ml-auto" />
          </div>
          <p className="text-xs text-muted-foreground">
            Reference {request!.contract_reference || request!.request_uid}
          </p>
          <Card className="overflow-hidden p-0">
            <object
              data={`/api/legal/esign/public/${token}/pdf#toolbar=1&view=FitH`}
              type="application/pdf"
              className="h-[420px] w-full sm:h-[560px]"
              aria-label="Document preview"
            >
              <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
                <FileText className="size-8" />
                <p>Your browser can’t display the document inline.</p>
                <Button
                  render={
                    <a href={`/api/legal/esign/public/${token}/pdf`} target="_blank" rel="noreferrer" />
                  }
                  variant="outline"
                  size="sm"
                >
                  Open document in a new tab
                </Button>
              </div>
            </object>
          </Card>
        </div>

        {/* Sign panel */}
        <div className="flex flex-col gap-4 lg:order-2">
          <Card className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-1">
              <p className="text-sm">
                Hello <span className="font-semibold">{signer!.name}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                You are signing as {signer!.role ? <span className="font-medium">{signer!.role}</span> : "a signer"} ·{" "}
                {signer!.email}
              </p>
            </div>

            {due && (
              <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <Clock className="size-3.5 shrink-0" />
                Please sign on or before {due}.
              </div>
            )}

            {request!.message && (
              <div className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-foreground/80">
                {request!.message}
              </div>
            )}

            <Separator />

            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium">Your signature</Label>
              {usesSavedSignature ? (
                <div className="flex flex-col gap-2 rounded-lg border bg-white p-3 dark:bg-muted/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/legal/esign/public/${token}/signature`}
                    alt={`Saved signature for ${signer!.name}`}
                    className="mx-auto max-h-24"
                  />
                  <p className="text-center text-xs text-muted-foreground">
                    Your authorized company signature will be applied.
                  </p>
                </div>
              ) : (
                <SignaturePad onChange={setSignatureData} allowDraw allowUpload height={170} />
              )}
            </div>

            {requireConfirm && (
              <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-foreground/80">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmed(v === true)}
                  className="mt-0.5"
                />
                <span>
                  I have reviewed the document and agree that my electronic signature is the legal equivalent of my
                  handwritten signature.
                </span>
              </label>
            )}

            <div className="flex flex-col gap-2">
              <Button onClick={submit} disabled={!canSubmit} className="w-full">
                {submitting ? (
                  <>
                    <Loader2 data-icon="inline-start" className="animate-spin" /> Signing…
                  </>
                ) : (
                  <>
                    <CheckCircle2 data-icon="inline-start" /> Sign document
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-rose-600 hover:text-rose-700"
                onClick={() => setRejectOpen(true)}
                disabled={submitting}
              >
                Decline to sign
              </Button>
            </div>

            <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Lock className="size-3" />
              Your action is recorded with a secure audit trail.
            </p>
          </Card>

          {/* Signing progress */}
          {data.progress.length > 1 && (
            <Card className="flex flex-col gap-2.5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Signing progress</p>
              <ul className="flex flex-col gap-2">
                {data.progress.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {p.name}
                      {p.role ? <span className="text-muted-foreground"> · {p.role}</span> : null}
                    </span>
                    <EsignStatusBadge status={p.status} className="shrink-0" />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline to sign</DialogTitle>
            <DialogDescription>
              Let the sender know why you’re declining. This will close the request for everyone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reject-reason" className="text-sm">
              Reason
            </Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. The contract terms need to be revised before I can sign."
              rows={4}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={rejecting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={reject}
              disabled={rejecting || !rejectReason.trim()}
            >
              {rejecting ? (
                <>
                  <Loader2 data-icon="inline-start" className="animate-spin" /> Declining…
                </>
              ) : (
                "Decline document"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  )
}
