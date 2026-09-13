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
import { inr } from "@/lib/finance-calc"
import type { FieldDef, ModuleConfig } from "@/lib/finance-schema"

type FormState = Record<string, string>

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
  const sections = useMemo(() => sectionsOf(cfg), [cfg])

  useEffect(() => {
    if (!open) return
    setError(null)
    setGstinConflicts([])
    const base = emptyForm(cfg)
    if (record) {
      for (const key of Object.keys(base)) {
        const v = record[key]
        if (checkboxKeys.has(key)) base[key] = v ? "1" : ""
        else base[key] = v === null || v === undefined ? "" : String(v)
      }
    }
    setForm(base)
  }, [open, record, cfg, checkboxKeys])

  function update(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    for (const f of cfg.fields) {
      if (f.required && !form[f.key]) {
        setError(`${f.label} is required`)
        return
      }
    }
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = { ...form }
    for (const key of checkboxKeys) payload[key] = form[key] ? 1 : 0
    if (record?.id) payload.id = record.id

    try {
      const res = await fetch(`/api/finance/module/${cfg.key}`, {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
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

            {cfg.partyLookup && (
              <PartyPicker
                cfg={cfg}
                selectedName={form[cfg.partyLookup.nameField] ?? ""}
                selectedId={form[cfg.partyLookup.idField] ?? ""}
                onPick={applyPartyPick}
                onChange={update}
              />
            )}

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
                (f) => f.section === section && !f.computed && !f.hidden,
              )
              if (!fields.length) return null
              return (
                <FieldGroup key={section}>
                  <h3 className="text-sm font-semibold text-foreground">{section}</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {fields.map((f) => (
                      <FieldInput key={f.key} field={f} value={form[f.key] ?? ""} onChange={update} />
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

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: string
  onChange: (key: string, value: string) => void
}) {
  const wide = field.type === "textarea"

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
              {(field.options ?? []).map((o) => (
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
          onChange={(e) => onChange(field.key, e.target.value)}
          required={field.required}
        />
      )}
    </Field>
  )
}
