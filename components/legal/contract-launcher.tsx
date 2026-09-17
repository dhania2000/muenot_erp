"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { variablesForSource, sourceMeta, type ContractTemplate, type ContractSource } from "@/lib/legal-contracts-shared"
import { FileSignature, FileText, Search, Loader2, CheckCircle2, AlertTriangle, Download, ExternalLink } from "lucide-react"

// ---------------------------------------------------------------------------
// Cross-module contract launcher (Phases 21-27, 63-68).
//
// A single reusable component any module can drop next to a record to generate
// a contract from an APPROVED/PUBLISHED template WITHOUT leaving the module and
// WITHOUT duplicating template copies. It talks to the same Legal Contracts
// APIs the dedicated Generate wizard uses.
//
//   <ContractLauncher source="employee" sourceRef={emp.id} sourceLabel={emp.name} />
//
// - Bound mode: pass sourceRef + sourceLabel → the linked record is fixed.
// - Picker mode: omit sourceRef → the user searches the source module inline.
// ---------------------------------------------------------------------------

type SourceRecord = { id: string; label: string; sublabel?: string }

export type ContractLauncherProps = {
  /** Which ERP module the contract's variables resolve from. */
  source: ContractSource
  /** Fixed source record id (bound mode). Omit for an inline picker. */
  sourceRef?: string | number | null
  /** Human label for the fixed record (bound mode). */
  sourceLabel?: string | null
  /** Restrict template choices to these contract types (e.g. ["Offer Letter"]). */
  contractTypes?: string[]
  /** Trigger button label. */
  label?: string
  buttonVariant?: "default" | "outline" | "secondary" | "ghost"
  buttonSize?: "default" | "sm" | "lg" | "icon"
  className?: string
  /** Called with the new contract id after a successful generation. */
  onGenerated?: (contractId: number) => void
}

export function ContractLauncher(props: ContractLauncherProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant={props.buttonVariant ?? "outline"}
        size={props.buttonSize ?? "sm"}
        className={props.className}
        onClick={() => setOpen(true)}
      >
        <FileSignature data-icon="inline-start" />
        {props.label ?? "Generate contract"}
      </Button>
      {open && <LauncherDialog {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function LauncherDialog({
  source,
  sourceRef: fixedRef,
  sourceLabel: fixedLabel,
  contractTypes,
  onGenerated,
  onClose,
}: ContractLauncherProps & { onClose: () => void }) {
  const meta = sourceMeta(source)
  const bound = fixedRef != null && fixedRef !== ""

  const { data: tplData, isLoading: tplLoading } = useSWR<{ templates: ContractTemplate[] }>(
    "/api/legal/contract-templates",
    fetcher,
  )
  const templates = useMemo(() => {
    const usable = (tplData?.templates || []).filter(
      (t) => (t.status === "Approved" || t.status === "Published") && t.source === source,
    )
    if (contractTypes && contractTypes.length) {
      return usable.filter((t) => contractTypes.includes(t.contract_type))
    }
    return usable
  }, [tplData, source, contractTypes])

  const [templateId, setTemplateId] = useState<number | null>(null)
  const template = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId])

  const [sourceRef, setSourceRef] = useState<string | null>(bound ? String(fixedRef) : null)
  const [sourceLabel, setSourceLabel] = useState<string>(bound ? String(fixedLabel ?? "") : "")
  const [search, setSearch] = useState("")

  const [manualVars, setManualVars] = useState<Record<string, string>>({})
  const [title, setTitle] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [renewalDate, setRenewalDate] = useState("")

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [missing, setMissing] = useState<string[]>([])
  const [done, setDone] = useState<{ id: number; ref: string } | null>(null)

  const pickerKey =
    !bound && source !== "manual"
      ? `/api/legal/contract-sources?source=${source}&search=${encodeURIComponent(search)}`
      : null
  const { data: recData, isLoading: recLoading } = useSWR<{ records: SourceRecord[] }>(pickerKey, fetcher)

  const manualFields = useMemo(
    () => (source === "manual" ? variablesForSource("manual").filter((v) => v.source === "manual") : []),
    [source],
  )

  const needsRecord = !bound && source !== "manual"
  const recordReady = bound || source === "manual" || !!sourceRef
  const canGenerate = !!templateId && recordReady && title.trim().length > 0 && !submitting

  async function generate(allowMissing: boolean) {
    if (!template) return
    setSubmitting(true)
    setError("")
    setMissing([])
    try {
      const res = await fetch("/api/legal/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          title: title.trim(),
          contractType: template.contract_type,
          category: template.category,
          source,
          sourceRef: source === "manual" ? null : sourceRef,
          manualVars,
          startDate: startDate || null,
          endDate: endDate || null,
          renewalDate: renewalDate || null,
          status: "Generated",
          allowMissing,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        const id = d.contract?.id as number
        toast.success(d.deduped ? "Opened existing contract for this record" : "Contract generated")
        setDone({ id, ref: d.contract?.reference_no || d.contract?.contract_uid || String(id) })
        onGenerated?.(id)
      } else {
        setError(d.error || "Could not generate contract")
        if (Array.isArray(d.missing)) setMissing(d.missing)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function chooseTemplate(t: ContractTemplate) {
    setTemplateId(t.id)
    setTitle((prev) => prev || (sourceLabel ? `${t.contract_type} — ${sourceLabel}` : t.name))
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate contract</DialogTitle>
          <DialogDescription>
            {bound ? (
              <>
                For {meta.partyRole.toLowerCase()} <span className="font-medium text-foreground">{sourceLabel}</span>. Uses an
                approved template and live {meta.module} data — no duplicate copies.
              </>
            ) : (
              <>Pick an approved template and a {meta.partyRole.toLowerCase()} record to merge into a ready-to-sign document.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <CheckCircle2 className="size-6" />
            </span>
            <div>
              <p className="font-medium">Contract {done.ref} is ready</p>
              <p className="text-sm text-muted-foreground">Download it, or open it in the Legal workspace to email or track.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button render={<a href={`/api/legal/contracts/${done.id}/pdf?download=1`} />}>
                <Download data-icon="inline-start" /> Download PDF
              </Button>
              <Button
                variant="outline"
                render={<a href={`/modules/legal/contracts?open=${done.id}`} target="_blank" rel="noreferrer" />}
              >
                <ExternalLink data-icon="inline-start" /> Open in Legal
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5 py-1">
            {/* Template */}
            <div className="grid gap-2">
              <Label>Template</Label>
              {tplLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading templates…
                </div>
              ) : templates.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No approved {meta.partyRole.toLowerCase()} templates yet. Publish one in Legal → Templates first.
                </div>
              ) : (
                <div className="grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
                  {templates.map((t) => (
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
                        {t.contract_type} · {t.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Record picker (only when not bound and not manual) */}
            {needsRecord && (
              <div className="grid gap-2">
                <Label>{meta.partyRole}</Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={`Search ${meta.label}…`}
                    className="pl-9"
                  />
                </div>
                <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
                  {recLoading && (
                    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading…
                    </div>
                  )}
                  {(recData?.records || []).map((rec) => (
                    <button
                      key={rec.id}
                      type="button"
                      onClick={() => {
                        setSourceRef(rec.id)
                        setSourceLabel(rec.label)
                      }}
                      className={`flex items-center justify-between rounded-lg border p-2.5 text-left transition-colors ${
                        sourceRef === rec.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/50"
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium">{rec.label}</div>
                        {rec.sublabel && <div className="text-xs text-muted-foreground">{rec.sublabel}</div>}
                      </div>
                      {sourceRef === rec.id && <CheckCircle2 className="size-4 text-primary" />}
                    </button>
                  ))}
                  {!recLoading && (recData?.records || []).length === 0 && (
                    <div className="py-4 text-center text-sm text-muted-foreground">No matching records.</div>
                  )}
                </div>
              </div>
            )}

            {/* Manual counterparty fields */}
            {source === "manual" && manualFields.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {manualFields.map((v) => (
                  <div key={v.token} className="grid gap-2">
                    <Label>{v.label}</Label>
                    <Input
                      value={manualVars[v.token] ?? ""}
                      onChange={(e) => setManualVars((m) => ({ ...m, [v.token]: e.target.value }))}
                      placeholder={v.example}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Title + dates */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label>Contract title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Offer Letter — Sandeep Kumar" />
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
                <Label>Renewal reminder date</Label>
                <Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="size-4" /> {error}
                </div>
                {missing.length > 0 && (
                  <p className="mt-1 text-xs">Missing required: {missing.join(", ")}. Fill them or generate anyway.</p>
                )}
              </div>
            )}
          </div>
        )}

        {!done && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            {missing.length > 0 && (
              <Button variant="secondary" onClick={() => generate(true)} disabled={submitting}>
                Generate anyway
              </Button>
            )}
            <Button onClick={() => generate(false)} disabled={!canGenerate}>
              {submitting ? "Generating…" : "Generate contract"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
