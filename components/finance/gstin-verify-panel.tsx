"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Loader2Icon,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  BadgeCheck,
  TriangleAlert,
} from "lucide-react"
import type { BadgeVariant, ModuleConfig } from "@/lib/finance-schema"

/** 15-char GSTIN: 2 state digits, 5 PAN letters, 4 digits, PAN entity letter, entity code, 'Z', checksum. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

/** Keys the server may return in `autofill` that map onto visible form fields. */
const AUTOFILL_KEYS = [
  "legal_name",
  "pan",
  "state",
  "state_code",
  "city",
  "pin_code",
  "billing_address",
  "gst_registration_type",
] as const

/** Server-authoritative snapshot fields — always overwritten, never a conflict. */
const META_KEYS = [
  "gst_trade_name",
  "gst_status",
  "gst_taxpayer_type",
  "business_constitution",
  "gst_registration_date",
  "gst_cancellation_date",
  "gst_block_status",
  "gst_verification_status",
  "gst_verified_at",
  "gst_verification_source",
] as const

type LookupResponse = {
  result: {
    state: string
    ok: boolean
    message?: string
    gstin: string
    status: string | null
    verificationStatus: string
    creditsRemaining?: number | null
    cached?: boolean
  }
  suggestedName: string | null
  autofill: Record<string, string>
  meta: Record<string, string>
  duplicate: { id: number; party_id: string; customer_name: string } | null
}

type Conflict = { key: string; label: string; current: string; verified: string }

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  Verified: "default",
  Cancelled: "destructive",
  Suspended: "destructive",
  Invalid: "destructive",
  "Not found": "destructive",
  Unverified: "outline",
  Error: "outline",
}

export function GstinVerifyPanel({
  cfg,
  form,
  update,
  recordId,
}: {
  cfg: ModuleConfig
  form: Record<string, string>
  update: (key: string, value: string) => void
  recordId?: number
}) {
  const [busy, setBusy] = useState(false)
  const [resp, setResp] = useState<LookupResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<Conflict[]>([])

  const labelFor = useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of cfg.fields) map[f.key] = f.label
    return map
  }, [cfg])

  const raw = form.gstin ?? ""
  const normalized = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15)
  const isValid = GSTIN_RE.test(normalized)

  // The last GSTIN we sent to the server. Seeded with the value the record
  // opened with so editing an already-saved vendor doesn't auto-fire a lookup.
  const lastRequested = useRef<string | null>(null)
  const seeded = useRef(false)
  if (!seeded.current) {
    seeded.current = true
    lastRequested.current = form.gst_verification_status ? normalized : null
  }

  const runLookup = useCallback(
    async (value: string) => {
      lastRequested.current = value
      setBusy(true)
      setError(null)
      try {
        const params = new URLSearchParams({ gstin: value })
        if (recordId) params.set("exclude_id", String(recordId))
        const res = await fetch(`/api/finance/vendors/gstin-lookup?${params.toString()}`)
        const json = (await res.json().catch(() => null)) as LookupResponse | { error: string } | null
        if (!res.ok || !json || "error" in json) {
          setError((json as any)?.error || "Verification failed. Please try again.")
          return
        }
        applyResult(json)
      } catch {
        setError("Network error during verification.")
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recordId, form],
  )

  function applyResult(json: LookupResponse) {
    setResp(json)

    // Meta fields are server-authoritative: always overwrite.
    for (const k of META_KEYS) {
      if (k in json.meta) update(k, json.meta[k])
    }

    const nextConflicts: Conflict[] = []

    // Vendor name: fill if empty, otherwise offer the trade/legal name as a conflict.
    if (json.suggestedName) {
      const current = (form.customer_name ?? "").trim()
      if (!current) update("customer_name", json.suggestedName)
      else if (current.toLowerCase() !== json.suggestedName.toLowerCase()) {
        nextConflicts.push({
          key: "customer_name",
          label: labelFor.customer_name ?? "Vendor name",
          current,
          verified: json.suggestedName,
        })
      }
    }

    for (const k of AUTOFILL_KEYS) {
      const verified = json.autofill[k]
      if (!verified) continue
      const current = (form[k] ?? "").trim()
      if (!current) update(k, verified)
      else if (current.toLowerCase() !== verified.toLowerCase()) {
        nextConflicts.push({ key: k, label: labelFor[k] ?? k, current, verified })
      }
    }

    setConflicts(nextConflicts)
  }

  // Debounced auto-verify while the user types a fresh, valid GSTIN.
  useEffect(() => {
    if (!isValid) return
    if (normalized === lastRequested.current) return
    const t = setTimeout(() => {
      if (!busy) void runLookup(normalized)
    }, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized, isValid])

  function resolveConflict(c: Conflict, useVerified: boolean) {
    if (useVerified) update(c.key, c.verified)
    setConflicts((prev) => prev.filter((x) => x.key !== c.key))
  }

  function applyAllConflicts() {
    for (const c of conflicts) update(c.key, c.verified)
    setConflicts([])
  }

  const status = resp?.result.verificationStatus
  const statusVariant = (status && STATUS_VARIANT[status]) || "outline"
  const StatusIcon =
    status === "Verified" ? ShieldCheck : status === "Unverified" || !status ? ShieldAlert : ShieldX

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <BadgeCheck className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">GSTIN verification</h3>
        {status && (
          <Badge variant={statusVariant} className="ml-auto gap-1">
            <StatusIcon className="size-3" />
            {status}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-56 flex-1">
          <FieldLabel htmlFor="gstin">GSTIN</FieldLabel>
          <Input
            id="gstin"
            value={raw}
            placeholder="22AAAAA0000A1Z5"
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
            aria-invalid={!!normalized && !isValid}
            onChange={(e) => update("gstin", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15))}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={!isValid || busy}
          onClick={() => void runLookup(normalized)}
        >
          {busy ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
          {busy ? "Verifying..." : "Verify GSTIN"}
        </Button>
      </div>

      {!!normalized && !isValid && (
        <p className="mt-2 text-xs text-destructive">Enter a valid 15-character GSTIN to verify.</p>
      )}

      {error && (
        <Alert variant="destructive" className="mt-3">
          <ShieldX className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {resp?.duplicate && (
        <Alert className="mt-3">
          <TriangleAlert className="size-4" />
          <AlertTitle>Possible duplicate</AlertTitle>
          <AlertDescription>
            GSTIN already used by{" "}
            <span className="font-medium">{resp.duplicate.customer_name}</span>{" "}
            (<span className="font-mono">{resp.duplicate.party_id}</span>).
          </AlertDescription>
        </Alert>
      )}

      {resp?.result.ok && conflicts.length === 0 && !error && (
        <p className="mt-3 text-xs text-muted-foreground">
          Details fetched from the GST network{resp.result.cached ? " (cached)" : ""} and filled where blank.
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="mt-3 space-y-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
              Verified values differ from what you entered
            </p>
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={applyAllConflicts}>
              Apply all
            </Button>
          </div>
          {conflicts.map((c) => (
            <div key={c.key} className="rounded-md bg-background p-2 text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">{c.label}</p>
              <div className="grid gap-1 sm:grid-cols-2">
                <div className="text-xs">
                  <span className="text-muted-foreground">Yours: </span>
                  <span className="break-words">{c.current}</span>
                </div>
                <div className="text-xs">
                  <span className="text-muted-foreground">Verified: </span>
                  <span className="break-words font-medium">{c.verified}</span>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" className="h-7" onClick={() => resolveConflict(c, true)}>
                  Use verified
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => resolveConflict(c, false)}>
                  Keep mine
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
