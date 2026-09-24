"use client"

import { useMemo, useState, useTransition } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Hash, Wand2, RotateCcw, Undo2, Play } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import {
  type NumberingRule,
  type ResetPolicy,
  renderNumber,
  clampPadding,
} from "@/lib/numbering/model"

type RuleRow = NumberingRule & {
  label: string
  module: string
  active: boolean
  custom: boolean
  sample: string
}
type CatalogueEntry = { entity: string; label: string; module: string; defaults: Omit<NumberingRule, "entity"> }
type Payload = {
  rules: RuleRow[]
  catalogue: CatalogueEntry[]
  tokens: { token: string; description: string }[]
  resetPolicies: ResetPolicy[]
  fiscalStartMonthDefault: number
}

const RESET_LABELS: Record<ResetPolicy, string> = {
  never: "Never (continuous)",
  yearly: "Every calendar year",
  fiscal: "Every fiscal year",
  monthly: "Every month",
  daily: "Every day",
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export function NumberingClient() {
  const { data, mutate, isLoading } = useSWR<Payload>("/api/admin/numbering", fetcher)
  const [editing, setEditing] = useState<RuleRow | null>(null)

  const rows = data?.rules ?? []
  const customCount = rows.filter((r) => r.custom).length

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Numbered entities" value={rows.length} hint="Document & master types" />
        <StatCard label="Custom rules" value={customCount} hint="Overriding the defaults" />
        <StatCard label="Using defaults" value={rows.length - customCount} hint="Inherit built-in format" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hash className="h-4 w-4" /> Numbering rules
          </CardTitle>
          <CardDescription>
            Every generated id — invoices, employees, vendors and more — flows through one race-safe engine.
            Configure the format per entity; the next real number is allocated atomically so duplicates are impossible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Reset</TableHead>
                    <TableHead>Sample</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.entity}>
                      <TableCell>
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.entity}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.module}</TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.format}</code>
                      </TableCell>
                      <TableCell className="text-sm">{RESET_LABELS[row.reset]}</TableCell>
                      <TableCell>
                        <code className="text-xs font-medium">{row.sample}</code>
                      </TableCell>
                      <TableCell>
                        {row.custom ? (
                          <Badge className="border-transparent bg-primary text-primary-foreground">Custom</Badge>
                        ) : (
                          <Badge variant="secondary">Default</Badge>
                        )}
                        {!row.active && <Badge variant="outline" className="ml-1">Off</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                          <Wand2 className="mr-1 h-3.5 w-3.5" /> Configure
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing && data && (
        <RuleDialog
          row={editing}
          tokens={data.tokens}
          resetPolicies={data.resetPolicies}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            mutate()
          }}
        />
      )}
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

function RuleDialog({
  row,
  tokens,
  resetPolicies,
  onClose,
  onSaved,
}: {
  row: RuleRow
  tokens: { token: string; description: string }[]
  resetPolicies: ResetPolicy[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    prefix: row.prefix,
    suffix: row.suffix,
    padding: String(row.padding),
    reset: row.reset,
    format: row.format,
    fiscalStartMonth: String(row.fiscalStartMonth),
    startNumber: String(row.startNumber),
    active: row.active,
  })
  const [nextNumber, setNextNumber] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const previewRule: NumberingRule = useMemo(
    () => ({
      entity: row.entity,
      prefix: form.prefix,
      suffix: form.suffix,
      padding: clampPadding(Number(form.padding) || 6),
      reset: form.reset,
      format: form.format || "{PREFIX}-{SEQ}",
      fiscalStartMonth: Number(form.fiscalStartMonth) || 4,
      startNumber: Number(form.startNumber) || 1,
    }),
    [form, row.entity],
  )

  const preview = useMemo(() => {
    try {
      return renderNumber(previewRule, previewRule.startNumber)
    } catch {
      return "—"
    }
  }, [previewRule])

  function patch(next: Partial<typeof form>) {
    setForm((f) => ({ ...f, ...next }))
  }

  function insertToken(token: string) {
    patch({ format: form.format + token })
  }

  async function save() {
    startTransition(async () => {
      const res = await fetch("/api/admin/numbering", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: row.entity, ...previewRule, active: form.active }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return toast.error(json?.error ?? "Failed to save rule")
      toast.success(`Saved numbering rule for ${row.label}`)
      onSaved()
    })
  }

  async function revert() {
    startTransition(async () => {
      const res = await fetch(`/api/admin/numbering/${row.entity}`, { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return toast.error(json?.error ?? "Failed to revert")
      toast.success(`${row.label} reverted to default`)
      onSaved()
    })
  }

  async function runAction(action: "allocate" | "reset") {
    startTransition(async () => {
      const res = await fetch(`/api/admin/numbering/${row.entity}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return toast.error(json?.error ?? "Action failed")
      if (action === "allocate") {
        setNextNumber(json.allocation.number)
        toast.success(`Allocated ${json.allocation.number}`)
      } else {
        setNextNumber(null)
        toast.success(`Sequence reset (${json.cleared} counter${json.cleared === 1 ? "" : "s"} cleared)`)
      }
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{row.label} numbering</DialogTitle>
          <DialogDescription>
            Entity key <code className="rounded bg-muted px-1 py-0.5">{row.entity}</code> · {row.module}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3">
          <div className="text-xs text-muted-foreground">Live preview (first number of the period)</div>
          <div className="font-mono text-lg font-semibold">{preview}</div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prefix">
            <Input value={form.prefix} onChange={(e) => patch({ prefix: e.target.value })} placeholder="EMP" />
          </Field>
          <Field label="Suffix">
            <Input value={form.suffix} onChange={(e) => patch({ suffix: e.target.value })} placeholder="(optional)" />
          </Field>
          <Field label="Padding (digits)">
            <Input
              type="number"
              min={1}
              max={12}
              value={form.padding}
              onChange={(e) => patch({ padding: e.target.value })}
            />
          </Field>
          <Field label="Start number">
            <Input
              type="number"
              min={0}
              value={form.startNumber}
              onChange={(e) => patch({ startNumber: e.target.value })}
            />
          </Field>
          <Field label="Reset rule">
            <Select value={form.reset} onValueChange={(v) => patch({ reset: v as ResetPolicy })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {resetPolicies.map((p) => (
                  <SelectItem key={p} value={p}>
                    {RESET_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Fiscal year starts">
            <Select
              value={form.fiscalStartMonth}
              onValueChange={(v) => patch({ fiscalStartMonth: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="Format template">
          <Input value={form.format} onChange={(e) => patch({ format: e.target.value })} className="font-mono" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tokens.map((t) => (
              <button
                key={t.token}
                type="button"
                onClick={() => insertToken(t.token)}
                title={t.description}
                className="rounded border bg-background px-1.5 py-0.5 text-xs hover:bg-muted"
              >
                {t.token}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex items-center gap-2 rounded-md border p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => runAction("allocate")}
          >
            <Play className="mr-1 h-3.5 w-3.5" /> Allocate test number
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => runAction("reset")}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset sequence
          </Button>
          {nextNumber && (
            <span className="ml-auto font-mono text-sm font-semibold">{nextNumber}</span>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" disabled={pending || !row.custom} onClick={revert}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> Revert to default
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={pending}>
              Save rule
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
