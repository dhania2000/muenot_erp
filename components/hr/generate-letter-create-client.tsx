"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LetterStatusBadge } from "@/components/hr/letter-status-badge"
import {
  ArrowLeft,
  Loader2,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Plus,
} from "lucide-react"
import {
  LETTER_TYPES,
  LETTER_CATEGORIES,
  LETTER_AUDIENCES,
  eventByKey,
  variablesForEvent,
  type LetterSource,
  type LetterTemplate,
} from "@/lib/hr-letters-shared"

const today = () => new Date().toISOString().slice(0, 10)

type Employee = { id: number; employee_id: string; employee_name: string; department?: string; designation?: string }

type PreviewResponse = {
  subject: string
  body: string
  recipientName: string | null
  recipientMeta: string | null
  validation: { valid: boolean; unknownVariables: string[]; unbalancedBlocks: string[]; errors: string[] }
  missing: string[]
}

type Form = {
  template_id: string
  employee_id: string
  event_key: string
  source: LetterSource
  source_ref: string
  letter_type: string
  category: string
  audience: string
  issue_date: string
  status: string
  subject: string
  body: string
}

const emptyForm: Form = {
  template_id: "",
  employee_id: "",
  event_key: "manual",
  source: "manual",
  letter_type: "Other",
  category: "General",
  audience: "Employee",
  source_ref: "",
  issue_date: today(),
  status: "Generated",
  subject: "",
  body: "",
}

export function GenerateLetterCreateClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const presetTemplate = searchParams.get("template")

  const { data: templateData } = useSWR<{ templates: LetterTemplate[] }>("/api/hr/letter-templates", fetcher)
  const { data: employeeData } = useSWR<{ employees: Employee[] }>("/api/hr/employees", fetcher)

  const templates = useMemo(
    () => (templateData?.templates || []).filter((t) => t.status === "Active"),
    [templateData],
  )
  const employees = employeeData?.employees || []

  const [form, setForm] = useState<Form>(emptyForm)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // Apply a template's definition into the form.
  function applyTemplate(t: LetterTemplate | null) {
    if (!t) {
      setForm((f) => ({ ...emptyForm, employee_id: f.employee_id, issue_date: f.issue_date }))
      return
    }
    const evt = eventByKey(t.event_key)
    setForm((f) => ({
      ...f,
      template_id: String(t.id),
      event_key: t.event_key,
      source: evt.source,
      letter_type: t.letter_type,
      category: t.category,
      audience: t.audience,
      subject: t.subject,
      body: t.body,
      // Clear the source ref when the source family changes.
      source_ref: evt.source === f.source ? f.source_ref : "",
    }))
  }

  // Preselect a template from the query string once templates load.
  const appliedPreset = useRef(false)
  useEffect(() => {
    if (appliedPreset.current || !presetTemplate || templates.length === 0) return
    const t = templates.find((x) => String(x.id) === presetTemplate)
    if (t) {
      applyTemplate(t)
      appliedPreset.current = true
    }
  }, [presetTemplate, templates])

  // Source records for the current event family.
  const needsOffboarding = form.source === "offboarding"
  const needsRecruitment = form.source === "recruitment"
  const needsPromotion = form.source === "promotion"
  const needsEmployee = form.source === "manual" || form.source === "employee" || needsPromotion

  const { data: offboardingData } = useSWR<{ offboarding: any[] }>(
    needsOffboarding ? "/api/hr/offboarding?pageSize=200" : null,
    fetcher,
  )
  const { data: offerData } = useSWR<{ offers: any[] }>(needsRecruitment ? "/api/recruit/offers" : null, fetcher)

  // Live preview — debounced whenever inputs that affect the merge change.
  const previewDeps = JSON.stringify({
    template_id: form.template_id,
    subject: form.subject,
    body: form.body,
    event_key: form.event_key,
    source: form.source,
    employee_id: form.employee_id,
    source_ref: form.source_ref,
    issue_date: form.issue_date,
  })
  useEffect(() => {
    if (!form.subject && !form.body && !form.template_id) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const handle = setTimeout(async () => {
      try {
        const res = await fetch("/api/hr/letters/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template_id: form.template_id || undefined,
            subject: form.subject,
            body: form.body,
            event_key: form.event_key,
            source: form.source,
            employee_id: form.employee_id || undefined,
            source_ref: form.source_ref || undefined,
            issue_date: form.issue_date,
          }),
        })
        const data = await res.json()
        if (!cancelled) setPreview(res.ok ? data : null)
      } catch {
        if (!cancelled) setPreview(null)
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDeps])

  function insertToken(token: string) {
    const el = bodyRef.current
    const snippet = `{{${token}}}`
    if (!el) {
      setForm((f) => ({ ...f, body: f.body + snippet }))
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = el.value.slice(0, start) + snippet + el.value.slice(end)
    setForm((f) => ({ ...f, body: next }))
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + snippet.length
    })
  }

  const evt = eventByKey(form.event_key)
  const variables = variablesForEvent(form.event_key)
  const missing = preview?.missing || []
  const errors = preview?.validation?.errors || []
  const unknown = preview?.validation?.unknownVariables || []

  const employeeRequired = needsEmployee
  const canGenerate =
    !saving &&
    (form.subject.trim() || form.body.trim()) &&
    errors.length === 0 &&
    (!employeeRequired || !!form.employee_id) &&
    (form.status === "Draft" || missing.length === 0)

  async function generate() {
    setSaving(true)
    try {
      const res = await fetch("/api/hr/letters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: form.template_id || undefined,
          subject: form.subject,
          body: form.body,
          letter_type: form.letter_type,
          category: form.category,
          audience: form.audience,
          event_key: form.event_key,
          source: form.source,
          source_ref: form.source_ref || undefined,
          employee_id: form.employee_id || undefined,
          issue_date: form.issue_date,
          status: form.status,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to generate letter")
      toast.success(body.deduped ? "An identical letter already existed — opened it." : "Letter generated")
      router.push("/modules/hr/letters")
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/modules/hr/letters/generate"
            className={buttonVariants({ variant: "outline", size: "icon" })}
            aria-label="Back to generate hub"
          >
            <ArrowLeft />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">Generate letter</h1>
            <p className="text-sm text-muted-foreground">Merge a template with real records and preview before issuing.</p>
          </div>
        </div>
        <Button onClick={generate} disabled={!canGenerate}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Sparkles data-icon="inline-start" />}
          Generate
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Editor */}
        <div className="flex flex-col gap-5">
          <section className="grid gap-4 rounded-lg border bg-card p-5">
            <div className="grid gap-2">
              <Label>Template</Label>
              <Select
                value={form.template_id || "blank"}
                onValueChange={(v) => applyTemplate(v === "blank" ? null : templates.find((t) => String(t.id) === v) || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Start blank" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blank">Start blank (ad-hoc)</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Event: <span className="font-medium text-foreground">{evt.label}</span> — {evt.description}
              </p>
            </div>

            {/* Source record selection */}
            {needsEmployee && (
              <div className="grid gap-2">
                <Label>Employee{employeeRequired ? " *" : ""}</Label>
                <Select value={form.employee_id} onValueChange={(v) => set({ employee_id: v ?? "" })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select employee" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>
                        {e.employee_id} · {e.employee_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {needsPromotion && (
              <div className="grid gap-2">
                <Label>Promotion reference</Label>
                <Input
                  value={form.source_ref}
                  onChange={(e) => set({ source_ref: e.target.value })}
                  placeholder="Promotion / increment record ID"
                />
                <p className="text-xs text-muted-foreground">Links the letter to the approved promotion record.</p>
              </div>
            )}

            {needsOffboarding && (
              <div className="grid gap-2">
                <Label>Offboarding case *</Label>
                <Select
                  value={form.source_ref}
                  onValueChange={(v) => {
                    const val = v ?? ""
                    const rec = (offboardingData?.offboarding || []).find(
                      (o) => String(o.offboarding_id ?? o.id) === val,
                    )
                    set({ source_ref: val, employee_id: rec?.employee_id ? String(rec.employee_id) : form.employee_id })
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select offboarding case" />
                  </SelectTrigger>
                  <SelectContent>
                    {(offboardingData?.offboarding || []).map((o) => (
                      <SelectItem key={o.id} value={String(o.offboarding_id ?? o.id)}>
                        {(o.offboarding_id ?? o.id)} · {o.employee_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {needsRecruitment && (
              <div className="grid gap-2">
                <Label>Recruitment offer *</Label>
                <Select value={form.source_ref} onValueChange={(v) => set({ source_ref: v ?? "" })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select offer" />
                  </SelectTrigger>
                  <SelectContent>
                    {(offerData?.offers || []).map((o) => (
                      <SelectItem key={o.id} value={String(o.offer_id ?? o.id)}>
                        {o.candidate_name}
                        {o.job_title ? ` · ${o.job_title}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Letter type</Label>
                <Select value={form.letter_type} onValueChange={(v) => set({ letter_type: v ?? "" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => set({ category: v ?? "" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Audience</Label>
                <Select value={form.audience} onValueChange={(v) => set({ audience: v ?? "" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_AUDIENCES.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Issue date</Label>
                <Input type="date" value={form.issue_date} onChange={(e) => set({ issue_date: e.target.value })} />
              </div>
            </div>
          </section>

          <section className="grid gap-4 rounded-lg border bg-card p-5">
            <div className="grid gap-2">
              <Label>Subject</Label>
              <Input value={form.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Letter subject" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Body</Label>
                {previewing && <span className="text-xs text-muted-foreground">Rendering…</span>}
              </div>
              <Textarea
                ref={bodyRef}
                value={form.body}
                onChange={(e) => set({ body: e.target.value })}
                rows={12}
                placeholder="Dear {{employee_name}}, …"
                className="font-mono text-xs leading-relaxed"
              />
            </div>
            <div className="grid gap-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Insert variable</Label>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    onClick={() => insertToken(v.token)}
                    title={v.label}
                    className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    <Plus className="size-3" />
                    {v.token}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* Preview + validation */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <div className="grid gap-2 rounded-lg border bg-card p-5">
            <Label>Save as</Label>
            <Select value={form.status} onValueChange={(v) => set({ status: v ?? "" })}>
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Draft">Draft (allow missing values)</SelectItem>
                <SelectItem value="Generated">Generated</SelectItem>
                <SelectItem value="Issued">Issued</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Validation summary */}
          {(errors.length > 0 || missing.length > 0 || unknown.length > 0) && (
            <div className="grid gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              {errors.map((e) => (
                <div key={e} className="flex items-start gap-2 text-amber-900 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{e}</span>
                </div>
              ))}
              {missing.length > 0 && (
                <div className="flex items-start gap-2 text-amber-900 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    Missing required values: <span className="font-mono">{missing.join(", ")}</span>. Save as Draft or
                    pick a record that provides them.
                  </span>
                </div>
              )}
              {unknown.length > 0 && (
                <div className="flex items-start gap-2 text-amber-900 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    Unknown placeholders (won&apos;t resolve): <span className="font-mono">{unknown.join(", ")}</span>
                  </span>
                </div>
              )}
            </div>
          )}
          {preview && errors.length === 0 && missing.length === 0 && unknown.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <CheckCircle2 className="size-4" /> All placeholders resolve — ready to generate.
            </div>
          )}

          {/* Paper preview */}
          <div className="rounded-lg border bg-muted/30 p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Live preview</span>
              <LetterStatusBadge status={form.status} />
            </div>
            <article className="rounded-md bg-background p-6 shadow-sm ring-1 ring-border">
              {preview ? (
                <>
                  <header className="mb-5 border-b pb-3">
                    <div className="text-sm font-semibold text-foreground">{preview.recipientName || "Recipient"}</div>
                    {preview.recipientMeta && (
                      <div className="text-xs text-muted-foreground">{preview.recipientMeta}</div>
                    )}
                    <div className="mt-1 text-xs text-muted-foreground">Date: {form.issue_date}</div>
                  </header>
                  <h2 className="mb-3 font-serif text-lg font-semibold text-foreground text-pretty">
                    {preview.subject || "Subject"}
                  </h2>
                  <div className="min-h-24 whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
                    {preview.body || "Letter body will appear here as you type."}
                  </div>
                </>
              ) : (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Choose a template or start writing to see the merged letter.
                </p>
              )}
            </article>
          </div>
        </div>
      </div>
    </div>
  )
}
