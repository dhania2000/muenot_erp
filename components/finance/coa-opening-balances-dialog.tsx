"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2Icon, Plus, Trash2, CalendarClock } from "lucide-react"
import { inr } from "@/lib/finance-calc"

type Row = Record<string, any>

type YearEntry = {
  financial_year: string
  opening_balance: string
  opening_balance_date: string
  posted?: boolean
  voucher_no?: string | null
}

/** Suggest the next financial-year label (e.g. "2026-27" → "2027-28"). */
function nextFyLabel(existing: YearEntry[]): string {
  const years = existing
    .map((e) => Number((e.financial_year.match(/^(\d{4})/) || [])[1]))
    .filter((n) => Number.isFinite(n))
  const base = years.length ? Math.max(...years) + 1 : new Date().getFullYear()
  return `${base}-${String((base + 1) % 100).padStart(2, "0")}`
}

/**
 * Manage an account's opening balance for every financial year. Each row is a
 * distinct year that posts its own balanced Opening Balance voucher through the
 * shared accounting engine — this dialog never writes a bare number.
 */
export function CoaOpeningBalancesDialog({
  open,
  onOpenChange,
  account,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  account: Row | null
  onSaved: () => void
}) {
  const [entries, setEntries] = useState<YearEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accountId = account ? String(account.account_id) : ""
  const nature = account?.nature || "Debit"

  useEffect(() => {
    if (!open || !accountId) return
    setError(null)
    setLoading(true)
    fetch(`/api/finance/chart-of-accounts/${encodeURIComponent(accountId)}/opening-balances`)
      .then((r) => r.json())
      .then((body) => {
        const years: YearEntry[] = Array.isArray(body?.years)
          ? body.years.map((y: any) => ({
              financial_year: String(y.financial_year),
              opening_balance: String(y.opening_balance ?? ""),
              opening_balance_date: y.opening_balance_date ?? "",
              posted: !!y.posted,
              voucher_no: y.voucher_no ?? null,
            }))
          : []
        setEntries(years)
      })
      .catch(() => setError("Could not load opening balances."))
      .finally(() => setLoading(false))
  }, [open, accountId])

  function update(index: number, key: keyof YearEntry, value: string) {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)))
  }
  function addYear() {
    setEntries((prev) => [
      ...prev,
      { financial_year: nextFyLabel(prev), opening_balance: "", opening_balance_date: "" },
    ])
  }
  function removeYear(index: number) {
    setEntries((prev) => prev.filter((_, i) => i !== index))
  }

  async function save() {
    setError(null)
    const seen = new Set<string>()
    for (const e of entries) {
      const fy = e.financial_year.trim()
      if (!/^\d{4}-\d{2}$/.test(fy)) {
        setError(`Enter each financial year as 2026-27. Got "${fy || "(blank)"}".`)
        return
      }
      if (seen.has(fy)) {
        setError(`Financial year ${fy} appears more than once.`)
        return
      }
      seen.add(fy)
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/finance/chart-of-accounts/${encodeURIComponent(accountId)}/opening-balances`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          years: entries
            .filter((e) => Number(e.opening_balance) > 0)
            .map((e) => ({
              financial_year: e.financial_year.trim(),
              opening_balance: Number(e.opening_balance),
              opening_balance_date: e.opening_balance_date || null,
            })),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Could not save opening balances.")
        setSaving(false)
        return
      }
      setSaving(false)
      onSaved()
      onOpenChange(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5" />
            Opening balances by year
          </DialogTitle>
          <DialogDescription>
            {account ? (
              <>
                {account.account_name}
                {account.account_code ? ` · ${account.account_code}` : ""} — each year posts its own balanced Opening
                Balance voucher on the <Badge variant="secondary" className="ml-1 align-middle">{nature}</Badge> side.
              </>
            ) : (
              "Manage per-financial-year opening balances."
            )}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {entries.length === 0 && (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No opening balances yet. Add a financial year to record one.
              </p>
            )}

            {entries.map((e, i) => (
              <div key={i} className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Financial year</label>
                  <Input
                    value={e.financial_year}
                    onChange={(ev) => update(i, "financial_year", ev.target.value)}
                    placeholder="2026-27"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Opening balance</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={e.opening_balance}
                    onChange={(ev) => update(i, "opening_balance", ev.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">As on date</label>
                  <Input
                    type="date"
                    value={e.opening_balance_date}
                    onChange={(ev) => update(i, "opening_balance_date", ev.target.value)}
                  />
                </div>
                <div className="flex items-end justify-between gap-2 sm:flex-col sm:items-end">
                  {e.posted && e.voucher_no ? (
                    <Badge variant="outline" className="whitespace-nowrap text-[10px]">
                      {e.voucher_no}
                    </Badge>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">Unposted</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${e.financial_year || "year"}`}
                    onClick={() => removeYear(i)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}

            <Button type="button" variant="outline" size="sm" onClick={addYear}>
              <Plus data-icon="inline-start" />
              Add financial year
            </Button>

            {entries.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Total across years:{" "}
                <span className="font-medium text-foreground">
                  {inr(entries.reduce((s, e) => s + (Number(e.opening_balance) || 0), 0))}
                </span>{" "}
                — a year set to 0 (or removed) reverses its voucher.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving || loading}>
            {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Save opening balances
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
