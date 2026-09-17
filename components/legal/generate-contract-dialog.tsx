"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import {
  CONTRACT_TYPES,
  CONTRACT_CATEGORIES,
  CONTRACT_SOURCE_META,
  variablesForSource,
  sourceMeta,
  type ContractTemplate,
} from "@/lib/legal-contracts-shared"
import { CheckCircle2, AlertTriangle, Search, Loader2, FileText, Check } from "lucide-react"

function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
}

type SourceRecord = { id: string; label: string; sublabel?: string }

type Props = {
  onClose: () => void
  onGenerated: (contractId: number) => void
}

const STEPS = ["Template", "Linked record", "Details", "Review"] as const

export function GenerateContractDialog({ onClose, onGenerated }: Props) {
  const [step, setStep] = useState(0)
  const { data: tplData } = useSWR<{ templates: ContractTemplate[] }>("/api/legal/contract-templates", fetcher)
  const usableTemplates = useMemo(
    () => (tplData?.templates || []).filter((t) => t.status === "Approved" || t.status === "Published"),
    [tplData],
  )

  const [templateId, setTemplateId] = useState<number | null>(null)
  const template = useMemo(() => usableTemplates.find((t) => t.id === templateId) || null, [usableTemplates, templateId])

  const [title, setTitle] = useState("")
  const [contractType, setContractType] = useState<string>(CONTRACT_TYPES[0])
  const [category, setCategory] = useState<string>(CONTRACT_CATEGORIES[0])
  const [source, setSource] = useState<string>("manual")

  const [sourceRef, setSourceRef] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState<string>("")
  const [manualVars, setManualVars] = useState<Record<string, string>>({})

  const [effectiveDate, setEffectiveDate] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [renewalDate, setRenewalDate] = useState("")

  const [preview, setPreview] = useState<{ rendered: string; hasUnresolved: boolean } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [missing, setMissing] = useState<string[]>([])

  // When a template is chosen, adopt its metadata.
  function chooseTemplate(t: ContractTemplate) {
    setTemplateId(t.id)
    setTitle((prev) => prev || t.name)
    setContractType(t.contract_type)
    setCategory(t.category)
    setSource(t.source)
    setSourceRef(null)
    setSourceLabel("")
    setManualVars({})
  }

  const manualFields = useMemo(
    () => (source === "manual" ? variablesForSource("manual").filter((v) => v.source === "manual") : []),
    [source],
  )

  const content = template?.content ?? ""

  // Load preview when entering the Review step.
  useEffect(() => {
    if (step !== 3) return
    let cancelled = false
    setPreviewing(true)
    ;(async () => {
      const res = await fetch("/api/legal/contract-templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          source,
          sourceRef,
          manualVars,
          title,
          effectiveDate,
          startDate,
          endDate,
          renewalDate,
        }),
      })
      if (cancelled) return
      setPreviewing(false)
      if (res.ok) {
        const d = await res.json()
        setPreview({ rendered: d.rendered, hasUnresolved: d.hasUnresolved })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [step, content, source, sourceRef, manualVars, title, effectiveDate, startDate, endDate, renewalDate])

  async function generate(allowMissing: boolean) {
    setSubmitting(true)
    setError("")
    setMissing([])
    const res = await fetch("/api/legal/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId,
        title,
        contractType,
        category,
        source,
        sourceRef,
        manualVars,
        effectiveDate: effectiveDate || null,
        startDate: startDate || null,
        endDate: endDate || null,
        renewalDate: renewalDate || null,
        status: "Generated",
        allowMissing,
      }),
    })
    setSubmitting(false)
    const d = await res.json().catch(() => ({}))
    if (res.ok) {
      onGenerated(d.contract.id)
    } else {
      setError(d.error || "Could not generate contract")
      if (Array.isArray(d.missing)) setMissing(d.missing)
    }
  }

  const canNext =
    (step === 0 && (templateId !== null) && title.trim().length > 0) ||
    (step === 1) ||
    (step === 2) ||
    step === 3

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[94vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Generate contract</DialogTitle>
          <DialogDescription>
            Merge a published template with live record data to produce a ready-to-sign agreement.
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <ol className="flex items-center gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`inline-flex size-6 items-center justify-center rounded-full border text-[11px] font-medium ${
                  i < step
                    ? "border-primary bg-primary text-primary-foreground"
                    : i === step
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground"
                }`}
              >
                {i < step ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={i === step ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
            </li>
          ))}
        </ol>

        <div className="min-h-[340px] py-2">
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label>Template</Label>
                {usableTemplates.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No published or approved templates yet. Publish a template first.
                  </div>
                ) : (
                  <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
                    {usableTemplates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => chooseTemplate(t)}
                        className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                          templateId === t.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/50"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 text-primary" />
                          <span className="font-medium">{t.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {t.contract_type} · {t.category} · {sourceMeta(t.source).partyRole}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Contract title</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. MSA — Acme Corp" />
                </div>
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <Select value={contractType} onValueChange={setContractType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONTRACT_TYPES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <SourceStep
              source={source}
              sourceRef={sourceRef}
              sourceLabel={sourceLabel}
              manualFields={manualFields}
              manualVars={manualVars}
              onPick={(rec) => {
                setSourceRef(rec.id)
                setSourceLabel(rec.label)
              }}
              onManualChange={(token, val) => setManualVars((m) => ({ ...m, [token]: val }))}
            />
          )}

          {step === 2 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Effective date</Label>
                <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTRACT_CATEGORIES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Start date</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>End date</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Renewal date</Label>
                <Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Final preview</Label>
                {preview && (
                  <span className={`inline-flex items-center gap-1 text-xs ${preview.hasUnresolved ? "text-amber-600" : "text-emerald-600"}`}>
                    {preview.hasUnresolved ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                    {preview.hasUnresolved ? "Some placeholders are empty" : "All placeholders resolved"}
                  </span>
                )}
              </div>
              <div className="max-h-[46vh] min-h-[300px] overflow-y-auto rounded-lg border bg-white p-6 text-sm leading-relaxed text-slate-900 shadow-sm">
                {previewing ? (
                  <div className="flex items-center gap-2 text-slate-400"><Loader2 className="size-4 animate-spin" /> Rendering…</div>
                ) : preview ? (
                  <div
                    className="[&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:w-full [&_td]:border [&_td]:border-slate-300 [&_td]:p-1.5"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(preview.rendered) }}
                  />
                ) : null}
              </div>
              {error && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> {error}</div>
                  {missing.length > 0 && (
                    <p className="mt-1 text-xs">Missing required: {missing.join(", ")}. You can go back and fill them, or generate anyway.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <Button type="button" variant="outline" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          <div className="flex items-center gap-2">
            {step < 3 && (
              <Button type="button" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue
              </Button>
            )}
            {step === 3 && (
              <>
                {missing.length > 0 && (
                  <Button type="button" variant="outline" disabled={submitting} onClick={() => generate(true)}>
                    Generate anyway
                  </Button>
                )}
                <Button type="button" disabled={submitting || previewing} onClick={() => generate(false)}>
                  {submitting ? "Generating…" : "Generate contract"}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SourceStep({
  source,
  sourceRef,
  sourceLabel,
  manualFields,
  manualVars,
  onPick,
  onManualChange,
}: {
  source: string
  sourceRef: string | null
  sourceLabel: string
  manualFields: ReturnType<typeof variablesForSource>
  manualVars: Record<string, string>
  onPick: (rec: SourceRecord) => void
  onManualChange: (token: string, val: string) => void
}) {
  const [search, setSearch] = useState("")
  const meta = sourceMeta(source)
  const key = source !== "manual" ? `/api/legal/contract-sources?source=${source}&search=${encodeURIComponent(search)}` : null
  const { data, isLoading } = useSWR<{ records: SourceRecord[] }>(key, fetcher)

  if (source === "manual") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          This template has no linked module. Fill the counterparty details by hand.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {manualFields.map((v) => (
            <div key={v.token} className="grid gap-2">
              <Label>{v.label}</Label>
              <Input
                value={manualVars[v.token] ?? ""}
                onChange={(e) => onManualChange(v.token, e.target.value)}
                placeholder={v.example}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Pick the <span className="font-medium text-foreground">{meta.partyRole}</span> record from{" "}
        <span className="font-medium text-foreground">{meta.module}</span>. Its fields auto-fill the contract.
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${meta.label}…`} className="pl-9" />
      </div>
      <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {isLoading && <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
        {(data?.records || []).map((rec) => (
          <button
            key={rec.id}
            type="button"
            onClick={() => onPick(rec)}
            className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
              sourceRef === rec.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/50"
            }`}
          >
            <div>
              <div className="font-medium">{rec.label}</div>
              {rec.sublabel && <div className="text-xs text-muted-foreground">{rec.sublabel}</div>}
            </div>
            {sourceRef === rec.id && <CheckCircle2 className="size-4 text-primary" />}
          </button>
        ))}
        {!isLoading && (data?.records || []).length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">No matching records found.</div>
        )}
      </div>
      {sourceRef && <p className="text-xs text-emerald-600">Selected: {sourceLabel}</p>}
    </div>
  )
}
