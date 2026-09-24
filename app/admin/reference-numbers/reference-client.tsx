"use client"

import { useMemo, useState, useTransition } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Barcode, Search, SlidersHorizontal, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"

type DuplicatePolicy = "off" | "warn" | "block"
type ReferenceType = "internal" | "external" | "customer" | "vendor" | "po" | "contract"
type ReferenceConfig = {
  docType: string
  refType: ReferenceType
  enabled: boolean
  required: boolean
  duplicate: DuplicatePolicy
}
type DocumentConfig = {
  docType: string
  label: string
  module: string
  custom: boolean
  configs: ReferenceConfig[]
}
type Payload = {
  documents: DocumentConfig[]
  catalogue: { docType: string; label: string; module: string }[]
  referenceTypes: { type: ReferenceType; label: string; description: string }[]
  duplicatePolicies: DuplicatePolicy[]
}
type Match = { docType: string; documentId: string; refType: ReferenceType; value: string }

const POLICY_LABELS: Record<DuplicatePolicy, string> = {
  off: "Allowed",
  warn: "Warn",
  block: "Blocked",
}

function PolicyBadge({ policy }: { policy: DuplicatePolicy }) {
  if (policy === "block") {
    return (
      <Badge className="gap-1 border-transparent bg-destructive text-destructive-foreground">
        <ShieldX className="h-3 w-3" /> Blocked
      </Badge>
    )
  }
  if (policy === "warn") {
    return (
      <Badge variant="secondary" className="gap-1">
        <ShieldAlert className="h-3 w-3" /> Warn
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <ShieldCheck className="h-3 w-3" /> Allowed
    </Badge>
  )
}

export function ReferenceClient() {
  const { data, mutate, isLoading } = useSWR<Payload>("/api/admin/reference-numbers", fetcher)
  const [editing, setEditing] = useState<DocumentConfig | null>(null)

  const documents = data?.documents ?? []
  const refLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of data?.referenceTypes ?? []) m.set(r.type, r.label)
    return (t: string) => m.get(t) ?? t
  }, [data?.referenceTypes])

  const enabledCount = documents.reduce((n, d) => n + d.configs.filter((c) => c.enabled).length, 0)
  const blockedCount = documents.reduce(
    (n, d) => n + d.configs.filter((c) => c.enabled && c.duplicate === "block").length,
    0,
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Documents" value={documents.length} hint="Carrying reference numbers" />
        <StatCard label="Enabled references" value={enabledCount} hint="Across all documents" />
        <StatCard label="Duplicate-blocked" value={blockedCount} hint="Cannot be shared" />
      </div>

      <LookupPanel refLabel={refLabel} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Barcode className="h-4 w-4" /> Reference configuration
          </CardTitle>
          <CardDescription>
            Choose which reference numbers each document captures, which are mandatory, and how duplicates
            are handled. Internal numbers are duplicate-blocked by default so they stay unique.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Enabled references</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.map((doc) => {
                    const enabled = doc.configs.filter((c) => c.enabled)
                    return (
                      <TableRow key={doc.docType}>
                        <TableCell>
                          <div className="font-medium">{doc.label}</div>
                          <div className="text-xs text-muted-foreground">{doc.docType}</div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{doc.module}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {enabled.length === 0 && (
                              <span className="text-xs text-muted-foreground">None</span>
                            )}
                            {enabled.map((c) => (
                              <Badge
                                key={c.refType}
                                variant="outline"
                                className="gap-1 font-normal"
                                title={POLICY_LABELS[c.duplicate]}
                              >
                                {refLabel(c.refType)}
                                {c.required && <span className="text-destructive">*</span>}
                                {c.duplicate === "block" && <ShieldX className="h-3 w-3" />}
                                {c.duplicate === "warn" && <ShieldAlert className="h-3 w-3" />}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          {doc.custom ? (
                            <Badge className="border-transparent bg-primary text-primary-foreground">
                              Custom
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Default</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(doc)}>
                            <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> Configure
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing && data && (
        <ConfigDialog
          doc={editing}
          referenceTypes={data.referenceTypes}
          duplicatePolicies={data.duplicatePolicies}
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

function LookupPanel({ refLabel }: { refLabel: (t: string) => string }) {
  const [value, setValue] = useState("")
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [pending, startTransition] = useTransition()

  function lookup() {
    const v = value.trim()
    if (!v) {
      setMatches(null)
      return
    }
    startTransition(async () => {
      const res = await fetch("/api/admin/reference-numbers/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "resolve", value: v }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json?.error ?? "Lookup failed")
        return
      }
      setMatches(json.matches ?? [])
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-4 w-4" /> Cross-reference lookup
        </CardTitle>
        <CardDescription>
          Trace any reference value to the documents that carry it — casing, spacing and punctuation are
          ignored.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) lookup()
            }}
            placeholder="e.g. PO-2026-0042"
            aria-label="Reference value to look up"
          />
          <Button onClick={lookup} disabled={pending}>
            <Search className="mr-1 h-4 w-4" /> Look up
          </Button>
        </div>
        {matches !== null && (
          <div className="rounded-md border">
            {matches.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No documents carry that reference.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Reference type</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((m, i) => (
                    <TableRow key={`${m.docType}-${m.documentId}-${m.refType}-${i}`}>
                      <TableCell className="text-sm">
                        <span className="font-medium">{m.documentId}</span>{" "}
                        <span className="text-muted-foreground">({m.docType})</span>
                      </TableCell>
                      <TableCell className="text-sm">{refLabel(m.refType)}</TableCell>
                      <TableCell className="font-mono text-xs">{m.value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ConfigDialog({
  doc,
  referenceTypes,
  duplicatePolicies,
  onClose,
  onSaved,
}: {
  doc: DocumentConfig
  referenceTypes: { type: ReferenceType; label: string; description: string }[]
  duplicatePolicies: DuplicatePolicy[]
  onClose: () => void
  onSaved: () => void
}) {
  const [rows, setRows] = useState<ReferenceConfig[]>(() => doc.configs.map((c) => ({ ...c })))
  const [pending, startTransition] = useTransition()

  const labelFor = (t: string) => referenceTypes.find((r) => r.type === t)?.label ?? t
  const descFor = (t: string) => referenceTypes.find((r) => r.type === t)?.description ?? ""

  function patch(refType: ReferenceType, next: Partial<ReferenceConfig>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.refType !== refType) return r
        const merged = { ...r, ...next }
        // Keep required + enabled consistent: enabling required implies enabled,
        // disabling a reference clears its required flag.
        if (next.required === true) merged.enabled = true
        if (next.enabled === false) merged.required = false
        return merged
      }),
    )
  }

  function save() {
    startTransition(async () => {
      const results = await Promise.all(
        rows.map((r) =>
          fetch("/api/admin/reference-numbers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              docType: doc.docType,
              refType: r.refType,
              enabled: r.enabled,
              required: r.required,
              duplicate: r.duplicate,
            }),
          }).then((res) => res.ok),
        ),
      )
      if (results.some((ok) => !ok)) {
        toast.error("Some references could not be saved")
        return
      }
      toast.success(`Saved reference configuration for ${doc.label}`)
      onSaved()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{doc.label} references</DialogTitle>
          <DialogDescription>
            Document type <code className="rounded bg-muted px-1 py-0.5">{doc.docType}</code> · {doc.module}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {rows.map((r, idx) => (
            <div key={r.refType}>
              {idx > 0 && <Separator className="mb-3" />}
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{labelFor(r.refType)}</div>
                    <div className="text-xs text-muted-foreground">{descFor(r.refType)}</div>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    Enabled
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => patch(r.refType, { enabled: v })}
                    />
                  </label>
                </div>
                {r.enabled && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={r.required}
                        onCheckedChange={(v) => patch(r.refType, { required: v })}
                      />
                      Required
                    </label>
                    <div className="flex items-center gap-2">
                      <Label className="text-sm">Duplicates</Label>
                      <Select
                        value={r.duplicate}
                        onValueChange={(v) => patch(r.refType, { duplicate: v as DuplicatePolicy })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {duplicatePolicies.map((p) => (
                            <SelectItem key={p} value={p}>
                              {POLICY_LABELS[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <PolicyBadge policy={r.duplicate} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending}>
            Save configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
