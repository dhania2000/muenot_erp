"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SCOPE_LABELS, type LegalHoldCatalogItem, type LegalHoldScope } from "./legal-hold-types"

const CUSTOM = "__custom__"

export type ItemDraft = {
  scope: LegalHoldScope
  catalogKey: string // "" (none), CUSTOM, or a catalog key
  module: string
  recordType: string
  recordRef: string
  matchField: string
  matchValue: string
  fileId: string
  note: string
}

export function emptyItemDraft(): ItemDraft {
  return {
    scope: "record_type",
    catalogKey: "",
    module: "",
    recordType: "",
    recordRef: "",
    matchField: "",
    matchValue: "",
    fileId: "",
    note: "",
  }
}

const FAMILY_SCOPES: LegalHoldScope[] = ["record_type", "record", "criteria"]

/** Validate a draft, returning a user-facing error message or null when valid. */
export function validateItemDraft(d: ItemDraft): string | null {
  if (d.scope === "module") {
    if (!d.module.trim()) return "Choose or enter a module."
    return null
  }
  if (d.scope === "file") {
    if (!Number(d.fileId)) return "Enter a valid file id."
    return null
  }
  // family scopes
  const hasFamily = (d.catalogKey && d.catalogKey !== CUSTOM) || d.module.trim()
  if (!hasFamily) return "Choose a record type."
  if (d.catalogKey === CUSTOM && (!d.module.trim() || !d.recordType.trim()))
    return "Custom record types need a module and a record-type label."
  if (d.scope === "record" && !d.recordRef.trim()) return "Enter the record id to hold."
  if (d.scope === "criteria" && !d.matchField.trim()) return "Enter the field to match."
  return null
}

/** Convert a draft into the API payload the store expects. */
export function itemDraftToPayload(d: ItemDraft): Record<string, unknown> {
  const note = d.note.trim() || null
  if (d.scope === "module") return { scope: "module", module: d.module.trim(), note }
  if (d.scope === "file") return { scope: "file", fileId: Number(d.fileId), module: d.module.trim() || null, note }
  const usingCatalog = d.catalogKey && d.catalogKey !== CUSTOM
  const base = {
    scope: d.scope,
    catalogKey: usingCatalog ? d.catalogKey : null,
    module: d.module.trim() || null,
    recordType: d.recordType.trim() || null,
    note,
  }
  if (d.scope === "record") return { ...base, recordRef: d.recordRef.trim() }
  if (d.scope === "criteria") return { ...base, matchField: d.matchField.trim(), matchValue: d.matchValue.trim() }
  return base
}

export function LegalHoldItemFields({
  draft,
  onChange,
  catalog,
}: {
  draft: ItemDraft
  onChange: (next: ItemDraft) => void
  catalog: LegalHoldCatalogItem[]
}) {
  const isFamily = FAMILY_SCOPES.includes(draft.scope)
  const isCustom = draft.catalogKey === CUSTOM

  function onPickFamily(key: string) {
    if (key === CUSTOM) {
      onChange({ ...draft, catalogKey: CUSTOM, module: "", recordType: "" })
      return
    }
    const entry = catalog.find((c) => c.key === key)
    onChange({
      ...draft,
      catalogKey: key,
      module: entry?.module ?? "",
      recordType: entry?.recordType ?? "",
    })
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <Label className="text-xs font-normal">What does this hold cover?</Label>
        <Select value={draft.scope} onValueChange={(v) => onChange({ ...draft, scope: v as LegalHoldScope })}>
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCOPE_LABELS) as LegalHoldScope[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft.scope === "module" && (
        <div className="grid gap-2">
          <Label htmlFor="lh-module" className="text-xs font-normal">
            Module
          </Label>
          <Input
            id="lh-module"
            value={draft.module}
            onChange={(e) => onChange({ ...draft, module: e.target.value })}
            placeholder="e.g. Finance"
          />
        </div>
      )}

      {isFamily && (
        <div className="grid gap-2">
          <Label className="text-xs font-normal">Record type</Label>
          <Select value={draft.catalogKey} onValueChange={onPickFamily}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder="Choose a record type" />
            </SelectTrigger>
            <SelectContent>
              {catalog.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.module} — {c.recordType}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom record type…</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {isFamily && isCustom && (
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-2">
            <Label htmlFor="lh-cust-module" className="text-xs font-normal">
              Module
            </Label>
            <Input
              id="lh-cust-module"
              value={draft.module}
              onChange={(e) => onChange({ ...draft, module: e.target.value })}
              placeholder="e.g. Legal"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lh-cust-type" className="text-xs font-normal">
              Record type
            </Label>
            <Input
              id="lh-cust-type"
              value={draft.recordType}
              onChange={(e) => onChange({ ...draft, recordType: e.target.value })}
              placeholder="e.g. Signed NDAs"
            />
          </div>
        </div>
      )}

      {draft.scope === "record" && (
        <div className="grid gap-2">
          <Label htmlFor="lh-record-ref" className="text-xs font-normal">
            Record id
          </Label>
          <Input
            id="lh-record-ref"
            value={draft.recordRef}
            onChange={(e) => onChange({ ...draft, recordRef: e.target.value })}
            placeholder="e.g. 4821"
          />
        </div>
      )}

      {draft.scope === "criteria" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-2">
            <Label htmlFor="lh-match-field" className="text-xs font-normal">
              Field
            </Label>
            <Input
              id="lh-match-field"
              value={draft.matchField}
              onChange={(e) => onChange({ ...draft, matchField: e.target.value })}
              placeholder="e.g. region"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lh-match-value" className="text-xs font-normal">
              Equals
            </Label>
            <Input
              id="lh-match-value"
              value={draft.matchValue}
              onChange={(e) => onChange({ ...draft, matchValue: e.target.value })}
              placeholder="e.g. EU"
            />
          </div>
        </div>
      )}

      {draft.scope === "file" && (
        <div className="grid gap-2">
          <Label htmlFor="lh-file-id" className="text-xs font-normal">
            Storage file id
          </Label>
          <Input
            id="lh-file-id"
            type="number"
            min={1}
            value={draft.fileId}
            onChange={(e) => onChange({ ...draft, fileId: e.target.value })}
            placeholder="e.g. 1042"
          />
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="lh-note" className="text-xs font-normal">
          Note (optional)
        </Label>
        <Input
          id="lh-note"
          value={draft.note}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          placeholder="Context for this item"
        />
      </div>
    </div>
  )
}
