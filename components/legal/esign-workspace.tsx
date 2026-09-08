"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSignature,
  PenTool,
  Plus,
  Send,
  Trash2,
  Upload,
} from "lucide-react"
import { SignaturePad, type CapturedSignature } from "@/components/legal/signature-pad"

type View = "home" | "self" | "send"

type PlacedSignature = CapturedSignature & {
  id: string
  xPct: number
  yPct: number
  widthPct: number
}

type SignRequest = {
  id: string
  document: string
  signer: string
  email: string
  status: "Sent" | "Signed" | "Declined"
  sentAt: string
}

export function EsignWorkspace() {
  const [view, setView] = useState<View>("home")

  return (
    <main className="space-y-6">
      <header className="flex items-start gap-3">
        {view !== "home" && (
          <button
            onClick={() => setView("home")}
            className="mt-1 inline-flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Back to eSign home"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FileSignature className="size-5" />
        </span>
        <div>
          <p className="text-sm text-muted-foreground">Legal workspace</p>
          <h1 className="text-2xl font-semibold tracking-tight">eSign</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Digitally sign contracts and letters, or send them out for signature.
          </p>
        </div>
      </header>

      {view === "home" && <Home onSelect={setView} />}
      {view === "self" && <SignYourself />}
      {view === "send" && <SendForSignatures />}
    </main>
  )
}

function Home({ onSelect }: { onSelect: (v: View) => void }) {
  const cards: { id: View; title: string; description: string; icon: typeof Send }[] = [
    {
      id: "send",
      title: "Send for signatures",
      description: "Email a document to one or more people and track when they sign.",
      icon: Send,
    },
    {
      id: "self",
      title: "Sign yourself",
      description: "Upload a contract or letter, place your signature, and download the signed PDF.",
      icon: PenTool,
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className="group flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-14 text-center transition-colors hover:border-primary/60 hover:bg-muted/40"
          >
            <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
              <Icon className="size-7" />
            </span>
            <span className="text-lg font-semibold">{c.title}</span>
            <span className="max-w-xs text-sm text-muted-foreground text-pretty">{c.description}</span>
          </button>
        )
      })}
    </div>
  )
}

function SignYourself() {
  const [docUrl, setDocUrl] = useState<string | null>(null)
  const [docSize, setDocSize] = useState<{ w: number; h: number } | null>(null)
  const [signatures, setSignatures] = useState<PlacedSignature[]>([])
  const [showPad, setShowPad] = useState(false)
  const [exporting, setExporting] = useState(false)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        setDocSize({ w: img.naturalWidth, h: img.naturalHeight })
        setDocUrl(url)
        setSignatures([])
      }
      img.src = url
    }
    reader.readAsDataURL(file)
  }

  function addSignature(sig: CapturedSignature) {
    setSignatures((prev) => [
      ...prev,
      { ...sig, id: crypto.randomUUID(), xPct: 0.08, yPct: 0.75, widthPct: 0.28 },
    ])
    setShowPad(false)
  }

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    const surface = surfaceRef.current
    if (!surface) return
    const sig = e.currentTarget.getBoundingClientRect()
    drag.current = { id, offsetX: e.clientX - sig.left, offsetY: e.clientY - sig.top }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    const surface = surfaceRef.current
    if (!d || !surface) return
    const rect = surface.getBoundingClientRect()
    const x = (e.clientX - d.offsetX - rect.left) / rect.width
    const y = (e.clientY - d.offsetY - rect.top) / rect.height
    setSignatures((prev) =>
      prev.map((s) =>
        s.id === d.id ? { ...s, xPct: Math.min(0.98, Math.max(0, x)), yPct: Math.min(0.98, Math.max(0, y)) } : s,
      ),
    )
  }, [])

  const onPointerUp = useCallback(() => {
    drag.current = null
  }, [])

  function resize(id: string, widthPct: number) {
    setSignatures((prev) => prev.map((s) => (s.id === id ? { ...s, widthPct } : s)))
  }

  function remove(id: string) {
    setSignatures((prev) => prev.filter((s) => s.id !== id))
  }

  async function exportPdf() {
    if (!docUrl || !docSize) return
    setExporting(true)
    try {
      const { jsPDF } = await import("jspdf")
      const orientation = docSize.w >= docSize.h ? "landscape" : "portrait"
      const doc = new jsPDF({ unit: "px", format: [docSize.w, docSize.h], orientation })
      doc.addImage(docUrl, "PNG", 0, 0, docSize.w, docSize.h)
      for (const s of signatures) {
        const w = s.widthPct * docSize.w
        const h = (s.height / s.width) * w
        doc.addImage(s.dataUrl, "PNG", s.xPct * docSize.w, s.yPct * docSize.h, w, h)
      }
      doc.save("signed-document.pdf")
    } finally {
      setExporting(false)
    }
  }

  const aspect = docSize ? docSize.w / docSize.h : 1 / 1.414

  if (!docUrl) {
    return (
      <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-card px-6 py-20 text-center transition-colors hover:border-primary/60 hover:bg-muted/40">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Upload className="size-6" />
        </span>
        <span className="text-lg font-semibold">Upload a document to sign</span>
        <span className="max-w-md text-sm text-muted-foreground text-pretty">
          Upload your contract or letter as an image (PNG or JPG). Tip: export a PDF page to an image first, then sign it
          here.
        </span>
        <input type="file" accept="image/png,image/jpeg" onChange={handleUpload} className="sr-only" />
      </label>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <section className="rounded-xl border border-border bg-card p-4">
        <div
          ref={surfaceRef}
          className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-white"
          style={{ aspectRatio: String(aspect) }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={docUrl || "/placeholder.svg"} alt="Document to sign" className="absolute inset-0 h-full w-full object-contain" />
          {signatures.map((s) => (
            <div
              key={s.id}
              onPointerDown={(e) => onPointerDown(e, s.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="group absolute cursor-move touch-none rounded border border-primary/60 bg-primary/5 ring-1 ring-primary/20"
              style={{ left: `${s.xPct * 100}%`, top: `${s.yPct * 100}%`, width: `${s.widthPct * 100}%` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.dataUrl || "/placeholder.svg"}
                alt="Placed signature"
                className="pointer-events-none w-full select-none"
                style={{ aspectRatio: `${s.width} / ${s.height}` }}
              />
              <button
                onClick={() => remove(s.id)}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute -right-2 -top-2 hidden size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
                aria-label="Remove signature"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </section>

      <aside className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Signatures</h2>
          <button
            onClick={() => setShowPad(true)}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            Add signature
          </button>

          {signatures.length > 0 ? (
            <ul className="mt-4 space-y-4">
              {signatures.map((s, i) => (
                <li key={s.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Signature {i + 1}</span>
                    <button
                      onClick={() => remove(s.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete signature"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <label className="mt-2 block text-xs text-muted-foreground">
                    Size
                    <input
                      type="range"
                      min={0.1}
                      max={0.6}
                      step={0.01}
                      value={s.widthPct}
                      onChange={(e) => resize(s.id, Number(e.target.value))}
                      className="mt-1 w-full accent-[var(--primary)]"
                    />
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Add a signature, then drag it onto the document to position it.
            </p>
          )}
        </div>

        <button
          onClick={exportPdf}
          disabled={signatures.length === 0 || exporting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="size-4" />
          {exporting ? "Preparing..." : "Download signed PDF"}
        </button>
        <button
          onClick={() => {
            setDocUrl(null)
            setDocSize(null)
            setSignatures([])
          }}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
        >
          Choose a different document
        </button>
      </aside>

      {showPad && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
          <SignaturePad onSave={addSignature} onCancel={() => setShowPad(false)} />
        </div>
      )}
    </div>
  )
}

function SendForSignatures() {
  const [requests, setRequests] = useState<SignRequest[]>([])
  const [form, setForm] = useState({ document: "", signer: "", email: "", message: "" })

  const canSend = form.document.trim() && form.signer.trim() && /.+@.+\..+/.test(form.email)

  function send() {
    if (!canSend) return
    setRequests((prev) => [
      {
        id: crypto.randomUUID(),
        document: form.document.trim(),
        signer: form.signer.trim(),
        email: form.email.trim(),
        status: "Sent",
        sentAt: new Date().toLocaleDateString(),
      },
      ...prev,
    ])
    setForm({ document: "", signer: "", email: "", message: "" })
  }

  const stats = useMemo(
    () => ({
      total: requests.length,
      awaiting: requests.filter((r) => r.status === "Sent").length,
      signed: requests.filter((r) => r.status === "Signed").length,
    }),
    [requests],
  )

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">New signature request</h2>
        <Field label="Document name">
          <input
            value={form.document}
            onChange={(e) => setForm({ ...form, document: e.target.value })}
            placeholder="e.g. Service Agreement — Acme Corp"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Signer name">
          <input
            value={form.signer}
            onChange={(e) => setForm({ ...form, signer: e.target.value })}
            placeholder="Full name"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Signer email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="name@company.com"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Message (optional)">
          <textarea
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
            placeholder="Add a note for the signer"
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <button
          onClick={send}
          disabled={!canSend}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="size-4" />
          Send request
        </button>
      </section>

      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Total requests", value: stats.total },
            { label: "Awaiting signature", value: stats.awaiting },
            { label: "Completed", value: stats.signed },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-border bg-card p-4">
              <p className="text-sm text-muted-foreground">{c.label}</p>
              <p className="mt-2 text-2xl font-semibold">{c.value}</p>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h2 className="font-semibold">Requests</h2>
          </div>
          {requests.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No requests yet. Fill the form to send your first document for signature.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <p className="text-sm font-medium">{r.document}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.signer} · {r.email} · sent {r.sentAt}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={r.status} />
                    {r.status === "Sent" && (
                      <button
                        onClick={() =>
                          setRequests((prev) =>
                            prev.map((x) => (x.id === r.id ? { ...x, status: "Signed" } : x)),
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                      >
                        <CheckCircle2 className="size-3.5" />
                        Mark signed
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function StatusBadge({ status }: { status: SignRequest["status"] }) {
  const styles: Record<SignRequest["status"], string> = {
    Sent: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    Signed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    Declined: "bg-destructive/10 text-destructive",
  }
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}>{status}</span>
}
