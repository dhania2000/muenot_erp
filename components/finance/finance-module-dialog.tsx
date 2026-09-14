"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"
import { inr, financialYearFor } from "@/lib/finance-calc"
import type { FieldDef, LookupConfig, ModuleConfig, VisibleWhen } from "@/lib/finance-schema"

type FormState = Record<string, string>

/**
 * Evaluate a `visibleWhen` rule against the current form. Checkbox truthiness is
 * normalized to "1" so a rule like `{ field: "gst_applicable", in: ["1"] }`
 * works for a checked box. Drives the dynamic Expense form (Phase 12).
 */
function isVisible(form: FormState, vw?: VisibleWhen) {
  if (!vw) return true
  return vw.in.includes(form[vw.field] ?? "")
}

/** Build the initial blank form from a config's input (non-computed) fields. */
function emptyForm(cfg: ModuleConfig): FormState {
  const form: FormState = {}
  for (const f of cfg.fields) {
    if (f.computed) continue
    form[f.key] = f.default ?? ""
  }
  return form
}

/** Unique section names, preserving their first-seen order. */
function sectionsOf(cfg: ModuleConfig) {
  const seen = new Set<string>()
  const order: string[] = []
  for (const f of cfg.fields) {
    if (!seen.has(f.section)) {
      seen.add(f.section)
      order.push(f.section)
    }
  }
  return order
}

export function FinanceModuleDialog({
  cfg,
  open,
  onOpenChange,
  record,
  onSaved,
}: {
  cfg: ModuleConfig
  open: boolean
  onOpenChange: (open: boolean) => void
  record: Record<string, any> | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(cfg))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [gstinConflicts, setGstinConflicts] = useState<
    { key: string; label: string; current: string; verified: string }[]
  >([])
  const [ifscState, setIfscState] = useState<{
    status: "idle" | "loading" | "ok" | "error"
    message?: string
  }>({ status: "idle" })
  // Pending duplicate returned by the server (HTTP 409) awaiting confirmation.
  const [dup, setDup] = useState<{ [k: string]: any; reason: string } | null>(null)
  // Runtime options for `dynamicOptions` selects (e.g. the freelancer's email
  // choices sourced from the picked freelancer row), keyed by field key.
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, string[]>>({})

  const fieldLabels = useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of cfg.fields) map[f.key] = f.label
    return map
  }, [cfg])

  const checkboxKeys = useMemo(
    () => new Set(cfg.fields.filter((f) => f.type === "checkbox").map((f) => f.key)),
    [cfg],
  )
  const computedFields = useMemo(() => cfg.fields.filter((f) => f.computed), [cfg])
  const computedKeys = useMemo(
    () => new Set(cfg.fields.filter((f) => f.computed).map((f) => f.key)),
    [cfg],
  )
  const sections = useMemo(() => sectionsOf(cfg), [cfg])

  useEffect(() => {
    if (!open) return
    setError(null)
    setGstinConflicts([])
    setIfscState({ status: "idle" })
    const base = emptyForm(cfg)
    if (record) {
      for (const key of Object.keys(base)) {
        const v = record[key]
        if (checkboxKeys.has(key)) base[key] = v ? "1" : ""
        else base[key] = v === null || v === undefined ? "" : String(v)
      }
    }
    setForm(base)
    // Seed dynamic-option selects with their stored value so it stays selectable
    // when editing before the source lookup is re-picked.
    const dyn: Record<string, string[]> = {}
    for (const f of cfg.fields) {
      if (f.dynamicOptions && base[f.key]) dyn[f.key] = [base[f.key]]
    }
    setDynamicOptions(dyn)
  }, [open, record, cfg, checkboxKeys])

  function update(key: string, value: string) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Selecting the module's date (e.g. Invoice date) auto-derives the
      // financial year, so users never hand-enter it. Only fill when the FY
      // field is empty or still matches the FY derived from the previous date,
      // so a manual override is never clobbered.
      const fyKey = cfg.financialYearColumn
      if (fyKey && key === cfg.dateColumn && fyKey in next && !computedKeys.has(fyKey)) {
        const prevDerived = financialYearFor(prev[key] ?? "")
        const currentFy = (prev[fyKey] ?? "").trim()
        if (!currentFy || currentFy === prevDerived) {
          next[fyKey] = financialYearFor(value)
        }
      }
      return next
    })
  }

  /**
   * Resolve the entered IFSC to a bank name + branch and fill the mapped fields.
   * Runs when the IFSC field loses focus. Because an IFSC uniquely identifies a
   * branch, resolved values overwrite whatever is there (an explicit action).
   */
  async function lookupIfsc(ifscValue: string) {
    const icfg = cfg.ifsc
    if (!icfg) return
    const normalized = ifscValue.trim().toUpperCase()
    if (normalized.length !== 11) {
      setIfscState({ status: "idle" })
      return
    }
    setIfscState({ status: "loading" })
    try {
      const res = await fetch(`${icfg.lookupPath}?ifsc=${encodeURIComponent(normalized)}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.result?.ok) {
        setIfscState({ status: "error", message: body.result?.message || body.error || "IFSC not found." })
        return
      }
      setForm((prev) => {
        const next = { ...prev }
        if (icfg.autofill.bank && body.autofill?.bank) next[icfg.autofill.bank] = body.autofill.bank
        if (icfg.autofill.branch && body.autofill?.branch) next[icfg.autofill.branch] = body.autofill.branch
        return next
      })
      const d = body.data
      setIfscState({
        status: "ok",
        message: d ? [d.bank, d.branch || d.city].filter(Boolean).join(" — ") : "Bank details filled.",
      })
    } catch {
      setIfscState({ status: "error", message: "Could not reach the IFSC lookup service." })
    }
  }

  /**
   * Apply a GSTIN verification result. `autofill` fields fill visible inputs
   * only when they are still empty (never clobber user-entered values), while
   * `meta` fields are server-authoritative and always overwrite the stored
   * snapshot. `suggestedName` seeds the vendor name when blank. When a verified
   * value differs from a value the user already typed, it is NOT overwritten —
   * instead it is surfaced as a conflict the user resolves explicitly.
   */
  function applyGstin(payload: {
    autofill?: Record<string, string>
    meta?: Record<string, string>
    suggestedName?: string | null
  }) {
    const conflicts: { key: string; label: string; current: string; verified: string }[] = []
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

    setForm((prev) => {
      const next = { ...prev }
      const consider = (key: string, verified: string) => {
        if (!(key in next) || verified === null || verified === undefined || String(verified).trim() === "") return
        const current = next[key] ?? ""
        if (!current.trim()) {
          next[key] = verified // empty → fill silently
        } else if (!same(current, verified)) {
          conflicts.push({ key, label: fieldLabels[key] ?? key, current, verified }) // differ → ask
        }
      }
      const nameKey = cfg.gstin?.autofill?.name
      if (nameKey && payload.suggestedName) consider(nameKey, payload.suggestedName)
      for (const [k, v] of Object.entries(payload.autofill ?? {})) consider(k, v)
      // `meta` is server-authoritative snapshot data — always overwrite.
      for (const [k, v] of Object.entries(payload.meta ?? {})) {
        if (k in next) next[k] = v
      }
      return next
    })
    setGstinConflicts(conflicts)
  }

  /** Accept a verified value for one conflicting field, then drop it from the list. */
  function resolveConflict(key: string, verified: string) {
    setForm((prev) => ({ ...prev, [key]: verified }))
    setGstinConflicts((prev) => prev.filter((c) => c.key !== key))
  }

  /**
   * Apply a picked party (e.g. a vendor on a Purchase Bill). Always sets the id
   * + name fields, and overwrites the mapped master defaults (TDS profile, etc.)
   * since choosing a party is an explicit action.
   */
  function applyPartyPick(row: Record<string, any>) {
    const pl = cfg.partyLookup
    if (!pl) return
    setForm((prev) => {
      const next = { ...prev }
      next[pl.idField] = row[pl.sourceIdColumn] != null ? String(row[pl.sourceIdColumn]) : ""
      next[pl.nameField] = row[pl.sourceNameColumn] != null ? String(row[pl.sourceNameColumn]) : ""
      for (const [sourceCol, targetKey] of Object.entries(pl.autofill)) {
        if (!(targetKey in next)) continue
        const v = row[sourceCol]
        if (checkboxKeys.has(targetKey)) next[targetKey] = v ? "1" : ""
        else next[targetKey] = v === null || v === undefined ? "" : String(v)
      }
      return next
    })
  }

  /**
   * Apply a row picked from a config-driven lookup (Phases 4–10). Sets the id +
   * name fields and overwrites each mapped snapshot column, since choosing a
   * master record is an explicit action. The server re-snapshots authoritatively
   * on save, so this is purely for immediate form feedback.
   */
  function applyLookupPick(l: LookupConfig, row: Record<string, any>) {
    // Build the runtime options for a dynamicOptions select (e.g. official vs
    // personal email) from the picked row, deduped and non-empty.
    let optionField: string | null = null
    let options: string[] = []
    if (l.optionSources) {
      optionField = l.optionSources.field
      const seen = new Set<string>()
      for (const col of l.optionSources.from) {
        const v = row[col]
        const s = v === null || v === undefined ? "" : String(v).trim()
        if (s && !seen.has(s)) {
          seen.add(s)
          options.push(s)
        }
      }
      setDynamicOptions((prev) => ({ ...prev, [optionField!]: options }))
    }

    setForm((prev) => {
      const next = { ...prev }
      next[l.idField] = row[l.sourceIdColumn] != null ? String(row[l.sourceIdColumn]) : ""
      next[l.nameField] = row[l.sourceNameColumn] != null ? String(row[l.sourceNameColumn]) : ""
      for (const [sourceCol, targetKey] of Object.entries(l.autofill)) {
        if (!(targetKey in next)) continue
        const v = row[sourceCol]
        if (checkboxKeys.has(targetKey)) next[targetKey] = v ? "1" : ""
        else next[targetKey] = v === null || v === undefined ? "" : String(v)
      }
      // Default the dynamic select to the first available option (official first).
      if (optionField && optionField in next) next[optionField] = options[0] ?? ""
      return next
    })
  }

  // Live mirror of the server calculation so users see totals before saving.
  const computed = useMemo(() => {
    if (!cfg.compute) return {} as Record<string, any>
    const raw: Record<string, any> = { ...form }
    for (const key of checkboxKeys) raw[key] = form[key] ? 1 : 0
    try {
      return cfg.compute(raw)
    } catch {
      return {} as Record<string, any>
    }
  }, [cfg, form, checkboxKeys])

  /**
   * Send the record. `force` sets `__forceCreate` so the server skips its
   * duplicate guard after the user confirms. A 409 with a `duplicate` payload
   * surfaces the existing record and pauses for confirmation (Phase 24).
   */
  async function submit(force: boolean) {
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = { ...form }
    for (const key of checkboxKeys) payload[key] = form[key] ? 1 : 0
    if (record?.id) payload.id = record.id
    if (force) payload.__forceCreate = true

    try {
      const res = await fetch(`/api/finance/module/${cfg.key}`, {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.duplicate) {
        setDup(body.duplicate)
        setLoading(false)
        return
      }
      if (!res.ok) {
        setError(body.error || `Unable to save ${cfg.label.toLowerCase()}`)
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Required only counts for fields the user can actually see right now — a
    // hidden conditional section must never block the save.
    for (const f of cfg.fields) {
      if (f.required && isVisible(form, f.visibleWhen) && !form[f.key]) {
        setError(`${f.label} is required`)
        return
      }
    }
    setDup(null)
    submit(false)
  }

  const idLabel = cfg.fields.find((f) => f.key === cfg.idColumn)?.label ?? "ID"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {record ? `Edit ${cfg.label} · ${record[cfg.idColumn] ?? ""}` : `New ${cfg.label}`}
            </DialogTitle>
            <DialogDescription>
              {record
                ? "Update the details. Calculated amounts refresh automatically as you type."
                : cfg.editableId
                  ? `The ${idLabel} is auto-generated when left blank. Totals and taxes are calculated for you.`
                  : cfg.idPrefix
                    ? `The ${idLabel} is generated automatically on save. Totals and taxes are calculated for you.`
                    : "Totals and taxes are calculated for you."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {dup && (
              <Alert variant="destructive">
                <AlertDescription>
                  <div className="flex flex-col gap-3">
                    <p className="font-medium">
                      {`A similar ${cfg.label.toLowerCase()} already exists${
                        dup[cfg.idColumn] ? ` (${dup[cfg.idColumn]})` : ""
                      }${dup.reason ? ` — matched by ${dup.reason}` : ""}. Create this one anyway?`}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setDup(null)
                          submit(true)
                        }}
                      >
                        Create anyway
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setDup(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {cfg.partyLookup && (
              <PartyPicker
                cfg={cfg}
                selectedName={form[cfg.partyLookup.nameField] ?? ""}
                selectedId={form[cfg.partyLookup.idField] ?? ""}
                onPick={applyPartyPick}
                onChange={update}
              />
            )}

            {(cfg.lookups ?? [])
              .filter((l) => isVisible(form, l.visibleWhen))
              .map((l) => (
                <LookupPicker
                  key={l.key}
                  lookup={l}
                  selectedName={form[l.nameField] ?? ""}
                  selectedId={form[l.idField] ?? ""}
                  onPick={(row) => applyLookupPick(l, row)}
                  onClear={() => {
                    update(l.idField, "")
                    update(l.nameField, "")
                  }}
                />
              ))}

            {cfg.gstin && (
              <GstinVerify
                cfg={cfg}
                value={form[cfg.gstin.column] ?? ""}
                excludeId={record?.id ?? null}
                onChange={update}
                onApply={applyGstin}
                onReset={() => setGstinConflicts([])}
              />
            )}

            {gstinConflicts.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription>
                  <div className="flex flex-col gap-3">
                    <p className="font-medium">
                      The GST network returned different values for {gstinConflicts.length} field
                      {gstinConflicts.length > 1 ? "s" : ""}. Your entries were kept — choose which to trust.
                    </p>
                    {gstinConflicts.map((c) => (
                      <div key={c.key} className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-background p-2 text-foreground">
                        <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span>
                            Yours: <span className="font-medium">{c.current}</span>
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span>
                            Verified: <span className="font-medium">{c.verified}</span>
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ml-auto"
                            onClick={() => resolveConflict(c.key, c.verified)}
                          >
                            Use verified
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {sections.map((section) => {
              const fields = cfg.fields.filter(
                (f) => f.section === section && !f.computed && !f.hidden && isVisible(form, f.visibleWhen),
              )
              if (!fields.length) return null
              return (
                <FieldGroup key={section}>
                  <h3 className="text-sm font-semibold text-foreground">{section}</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {fields.map((f) => (
                      <FieldInput
                        key={f.key}
                        field={f}
                        value={form[f.key] ?? ""}
                        onChange={update}
                        dynamicOptions={f.dynamicOptions ? dynamicOptions[f.key] ?? [] : undefined}
                        lookup={
                          cfg.ifsc && f.key === cfg.ifsc.column
                            ? {
                                status: ifscState.status,
                                message: ifscState.message,
                                onLookup: lookupIfsc,
                                onReset: () => setIfscState({ status: "idle" }),
                              }
                            : undefined
                        }
                        uploadPath={f.upload ? cfg.uploadPath : undefined}
                      />
                    ))}
                  </div>
                </FieldGroup>
              )
            })}

            {computedFields.length > 0 && (
              <FieldGroup>
                <h3 className="text-sm font-semibold text-foreground">Calculated automatically</h3>
                <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-3">
                  {computedFields.map((f) => {
                    const value = computed[f.key]
                    return (
                      <div key={f.key} className="flex flex-col">
                        <span className="text-xs text-muted-foreground">{f.label}</span>
                        <span className="font-medium">
                          {f.money ? inr(value) : value === undefined || value === null ? "—" : String(value)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </FieldGroup>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {record ? "Save changes" : `Create ${cfg.label.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type GstinResult = {
  state: string
  ok: boolean
  message?: string
  gstin?: string
  status?: string | null
  verificationStatus?: string
  cached?: boolean
}

/**
 * GSTIN verification panel for master records. Calls the server lookup route
 * (which keeps the API key server-side), then hands the normalized result back
 * to the form via `onApply`. The GSTIN input itself lives here so the verify
 * button sits inline with the value.
 */
function GstinVerify({
  cfg,
  value,
  excludeId,
  onChange,
  onApply,
  onReset,
}: {
  cfg: ModuleConfig
  value: string
  excludeId: number | null
  onChange: (key: string, value: string) => void
  onApply: (payload: {
    autofill?: Record<string, string>
    meta?: Record<string, string>
    suggestedName?: string | null
  }) => void
  onReset: () => void
}) {
  const gcfg = cfg.gstin!
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<GstinResult | null>(null)
  const [duplicate, setDuplicate] = useState<{ party_id: string; customer_name: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const normalized = value.trim().toUpperCase()
  const looksComplete = normalized.length === 15

  async function verify() {
    if (!looksComplete) {
      setNote("Enter a complete 15-character GSTIN to verify.")
      return
    }
    setChecking(true)
    setNote(null)
    setResult(null)
    setDuplicate(null)
    try {
      const params = new URLSearchParams({ gstin: normalized })
      if (excludeId) params.set("exclude_id", String(excludeId))
      const res = await fetch(`${gcfg.lookupPath}?${params.toString()}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNote(body.error || "Verification failed. Please try again.")
        return
      }
      setResult(body.result ?? null)
      if (body.duplicate) setDuplicate(body.duplicate)
      onApply({ autofill: body.autofill, meta: body.meta, suggestedName: body.suggestedName })
    } catch {
      setNote("Could not reach the verification service.")
    } finally {
      setChecking(false)
    }
  }

  const badgeVariant =
    result?.state === "verified"
      ? "default"
      : result?.state === "invalid" || result?.state === "not_found"
        ? "destructive"
        : "secondary"

  return (
    <FieldGroup>
      <h3 className="text-sm font-semibold text-foreground">GSTIN verification</h3>
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field className="flex-1">
            <FieldLabel htmlFor={gcfg.column}>GSTIN</FieldLabel>
            <Input
              id={gcfg.column}
              value={value}
              placeholder="15-character GSTIN"
              autoCapitalize="characters"
              maxLength={15}
              onChange={(e) => {
                onChange(gcfg.column, e.target.value.toUpperCase())
                setResult(null)
                setDuplicate(null)
                setNote(null)
                onReset()
              }}
            />
          </Field>
          <Button type="button" variant="secondary" onClick={verify} disabled={checking || !looksComplete}>
            {checking && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Verify GSTIN
          </Button>
        </div>

        {result && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={badgeVariant}>{result.verificationStatus ?? result.state}</Badge>
            {result.status && <span className="text-muted-foreground">Portal status: {result.status}</span>}
            {result.cached && <span className="text-xs text-muted-foreground">(cached)</span>}
            {result.message && !result.ok && <span className="text-destructive">{result.message}</span>}
          </div>
        )}

        {duplicate && (
          <Alert variant="destructive">
            <AlertDescription>
              Possible duplicate: this GSTIN is already on file for{" "}
              <span className="font-medium">{duplicate.customer_name}</span> ({duplicate.party_id}). Saving will
              create a second record with the same GSTIN.
            </AlertDescription>
          </Alert>
        )}

        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        {result?.ok && (
          <p className="text-xs text-muted-foreground">
            Verified details filled empty fields below. Existing values were kept unchanged.
          </p>
        )}
      </div>
    </FieldGroup>
  )
}

/**
 * Searchable party selector for transaction modules (e.g. the vendor on a
 * Purchase Bill). Loads master rows from the source module's list API and, on
 * pick, hands the full row back so the dialog can copy id/name + master
 * defaults into the form.
 */
function PartyPicker({
  cfg,
  selectedName,
  selectedId,
  onPick,
  onChange,
}: {
  cfg: ModuleConfig
  selectedName: string
  selectedId: string
  onPick: (row: Record<string, any>) => void
  onChange: (key: string, value: string) => void
}) {
  const pl = cfg.partyLookup!
  const [query, setQuery] = useState("")
  const [openList, setOpenList] = useState(false)
  const { data } = useSWR<{ rows: Record<string, any>[] }>(
    `/api/finance/module/${pl.sourceKey}`,
    fetcher,
  )
  const rows = data?.rows ?? []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? rows.filter((r) => {
          const name = String(r[pl.sourceNameColumn] ?? "").toLowerCase()
          const id = String(r[pl.sourceIdColumn] ?? "").toLowerCase()
          return name.includes(q) || id.includes(q)
        })
      : rows
    return base.slice(0, 20)
  }, [rows, query, pl])

  return (
    <FieldGroup>
      <h3 className="text-sm font-semibold text-foreground">{pl.label}</h3>
      <div className="relative flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
        <Field>
          <FieldLabel htmlFor="party-picker">Search {pl.label.toLowerCase()}</FieldLabel>
          <Input
            id="party-picker"
            placeholder={`Type a ${pl.label.toLowerCase()} name or code`}
            value={query}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setOpenList(true)
            }}
            onFocus={() => setOpenList(true)}
          />
        </Field>

        {selectedName && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Selected:</span>
            <Badge variant="secondary">{selectedName}</Badge>
            {selectedId && <span className="font-mono text-xs text-muted-foreground">#{selectedId}</span>}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                onChange(pl.idField, "")
                onChange(pl.nameField, "")
                setQuery("")
              }}
            >
              Clear
            </Button>
          </div>
        )}

        {openList && query.trim() && (
          <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
            {filtered.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No matching {pl.label.toLowerCase()} found.</p>
            )}
            {filtered.map((r) => (
              <button
                key={r.id}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60"
                onClick={() => {
                  onPick(r)
                  setQuery("")
                  setOpenList(false)
                }}
              >
                <span className="font-medium">{r[pl.sourceNameColumn]}</span>
                <span className="font-mono text-xs text-muted-foreground">{r[pl.sourceIdColumn]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </FieldGroup>
  )
}

/**
 * Config-driven master picker (Phases 4–10). Unlike PartyPicker (which loads a
 * whole module list and filters client-side), this hits a dedicated lookup
 * endpoint that server-filters + limits results, so it scales to large masters
 * and mixed sources (employees, vendors, accounts, projects, banks). On pick it
 * hands the row up so the dialog can fill the id/name + snapshot columns.
 */
function LookupPicker({
  lookup,
  selectedName,
  selectedId,
  onPick,
  onClear,
}: {
  lookup: LookupConfig
  selectedName: string
  selectedId: string
  onPick: (row: Record<string, any>) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState("")
  const [openList, setOpenList] = useState(false)
  const sep = lookup.path.includes("?") ? "&" : "?"
  const key =
    openList || selectedName
      ? `${lookup.path}${sep}search=${encodeURIComponent(query.trim())}`
      : null
  const { data, isLoading } = useSWR<Record<string, any>>(key, fetcher)
  const rowsKey = lookup.rowsKey ?? "rows"
  const rows: Record<string, any>[] = (data?.[rowsKey] as any[]) ?? []

  const selectable = useMemo(() => {
    const rules = lookup.selectableWhen ?? []
    if (!rules.length) return rows
    return rows.filter((r) => rules.every((rule) => rule.in.includes(String(r[rule.column] ?? ""))))
  }, [rows, lookup.selectableWhen])

  return (
    <FieldGroup>
      <h3 className="text-sm font-semibold text-foreground">
        {lookup.label}
        {lookup.required && <span className="text-destructive"> *</span>}
      </h3>
      <div className="relative flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
        <Field>
          <FieldLabel htmlFor={`lookup-${lookup.key}`}>Search {lookup.label.toLowerCase()}</FieldLabel>
          <Input
            id={`lookup-${lookup.key}`}
            placeholder={lookup.placeholder ?? `Type a ${lookup.label.toLowerCase()} name or code`}
            value={query}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setOpenList(true)
            }}
            onFocus={() => setOpenList(true)}
          />
        </Field>

        {selectedName && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Selected:</span>
            <Badge variant="secondary">{selectedName}</Badge>
            {selectedId && <span className="font-mono text-xs text-muted-foreground">#{selectedId}</span>}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                onClear()
                setQuery("")
              }}
            >
              Clear
            </Button>
          </div>
        )}

        {openList && (
          <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
            {isLoading && <p className="p-3 text-sm text-muted-foreground">Searching…</p>}
            {!isLoading && selectable.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No matching {lookup.label.toLowerCase()} found.</p>
            )}
            {selectable.map((r, i) => (
              <button
                key={String(r[lookup.sourceIdColumn] ?? i)}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60"
                onClick={() => {
                  onPick(r)
                  setQuery("")
                  setOpenList(false)
                }}
              >
                <span className="font-medium">{r[lookup.sourceNameColumn]}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {r[lookup.sourceIdColumn]}
                  {lookup.sourceSubColumn && r[lookup.sourceSubColumn]
                    ? ` · ${r[lookup.sourceSubColumn]}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </FieldGroup>
  )
}

function FieldInput({
  field,
  value,
  onChange,
  dynamicOptions,
  lookup,
  uploadPath,
}: {
  field: FieldDef
  value: string
  onChange: (key: string, value: string) => void
  dynamicOptions?: string[]
  lookup?: {
    status: "idle" | "loading" | "ok" | "error"
    message?: string
    onLookup: (value: string) => void
    onReset: () => void
  }
  uploadPath?: string
}) {
  const wide = field.type === "textarea"
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  async function uploadFile(file: File) {
    if (!uploadPath) return
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(uploadPath, { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setUploadError(body.error || "Upload failed")
        return
      }
      const url: string = body.url || body.pathname || ""
      if (url) {
        // Supporting-docs style fields accumulate a comma-separated list; other
        // document fields hold a single URL.
        const existing = value.trim()
        onChange(field.key, existing ? `${existing},${url}` : url)
      }
    } catch {
      setUploadError("Upload failed")
    } finally {
      setUploading(false)
    }
  }

  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <Checkbox checked={!!value} onCheckedChange={(c) => onChange(field.key, c ? "1" : "")} />
        {field.label}
      </label>
    )
  }

  if (field.type === "select") {
    const empty = field.optional
    const emptyValue = "__none__"
    // Dynamic selects use the runtime options; always keep the current value
    // selectable even if it isn't in the supplied list (e.g. an edited record).
    const baseOptions = field.dynamicOptions ? dynamicOptions ?? [] : field.options ?? []
    const options =
      value && !baseOptions.includes(value) ? [value, ...baseOptions] : baseOptions
    return (
      <Field>
        <FieldLabel>{field.label}</FieldLabel>
        <Select
          value={value === "" && empty ? emptyValue : value}
          onValueChange={(v) => onChange(field.key, !v || v === emptyValue ? "" : String(v))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {empty && <SelectItem value={emptyValue}>{field.emptyLabel ?? "—"}</SelectItem>}
              {options.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    )
  }

  return (
    <Field className={wide ? "sm:col-span-2 lg:col-span-3" : undefined}>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      {field.type === "textarea" ? (
        <Textarea
          id={field.key}
          rows={2}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      ) : (
        <Input
          id={field.key}
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          step={field.type === "number" ? "any" : undefined}
          placeholder={field.placeholder}
          value={value}
          autoCapitalize={lookup ? "characters" : undefined}
          maxLength={lookup ? 11 : undefined}
          onChange={(e) => {
            const v = lookup ? e.target.value.toUpperCase() : e.target.value
            onChange(field.key, v)
            lookup?.onReset()
          }}
          onBlur={lookup ? () => lookup.onLookup(value) : undefined}
          required={field.required}
        />
      )}
      {lookup && (
        <span
          className={
            lookup.status === "error"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {lookup.status === "loading"
            ? "Looking up bank…"
            : lookup.status === "ok" || lookup.status === "error"
              ? lookup.message
              : "Bank name & branch fill in automatically."}
        </span>
      )}
    </Field>
  )
}
