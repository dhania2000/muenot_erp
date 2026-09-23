"use client"

// Audit log viewer: search, filter, inspect, and export the immutable
// enterprise audit trail. Read-only by design; the log itself is append-only.
import { useCallback, useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import {
  DownloadIcon,
  SearchIcon,
  ShieldCheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  BanIcon,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"

type AuditEntry = {
  id: number
  requestId: string | null
  tenantId: number | null
  actorUserId: number | null
  actorName: string | null
  actorEmail: string | null
  actorRole: string | null
  sessionId: string | null
  ipAddress: string | null
  userAgent: string | null
  action: string
  entityType: string | null
  entityId: string | null
  entityLabel: string | null
  result: "success" | "failure" | "denied"
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  integrityHash: string | null
  createdAt: string
}

type ApiResponse = {
  entries: AuditEntry[]
  total: number
  filters: { actions: string[]; entityTypes: string[] }
  limit: number
  offset: number
}

const ALL = "__all__"
const PAGE_SIZE = 50

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load audit log")
    return r.json() as Promise<ApiResponse>
  })

const RESULT_META: Record<AuditEntry["result"], { label: string; variant: "secondary" | "destructive" | "outline"; Icon: typeof CircleCheckIcon }> = {
  success: { label: "Success", variant: "secondary", Icon: CircleCheckIcon },
  failure: { label: "Failure", variant: "destructive", Icon: CircleXIcon },
  denied: { label: "Denied", variant: "outline", Icon: BanIcon },
}

function formatTimestamp(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function AuditLogViewer() {
  const [q, setQ] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [action, setAction] = useState(ALL)
  const [entityType, setEntityType] = useState(ALL)
  const [result, setResult] = useState(ALL)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<AuditEntry | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0)
  }, [debouncedQ, action, entityType, result])

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (debouncedQ) params.set("q", debouncedQ)
    if (action !== ALL) params.set("action", action)
    if (entityType !== ALL) params.set("entityType", entityType)
    if (result !== ALL) params.set("result", result)
    params.set("limit", String(PAGE_SIZE))
    params.set("offset", String(page * PAGE_SIZE))
    return params.toString()
  }, [debouncedQ, action, entityType, result, page])

  const { data, error, isLoading } = useSWR(
    `/api/admin/security/audit-log?${queryString}`,
    fetcher,
    { keepPreviousData: true },
  )

  const exportCsv = useCallback(() => {
    const params = new URLSearchParams()
    if (debouncedQ) params.set("q", debouncedQ)
    if (action !== ALL) params.set("action", action)
    if (entityType !== ALL) params.set("entityType", entityType)
    if (result !== ALL) params.set("result", result)
    params.set("format", "csv")
    window.open(`/api/admin/security/audit-log?${params.toString()}`, "_blank")
  }, [debouncedQ, action, entityType, result])

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const actions = data?.filters.actions ?? []
  const entityTypes = data?.filters.entityTypes ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle className="flex items-center gap-2">
                <ShieldCheckIcon data-icon="inline-start" />
                Audit log
              </CardTitle>
              <CardDescription>
                Immutable, append-only record of every meaningful operation. {total.toLocaleString()} matching{" "}
                {total === 1 ? "entry" : "entries"}.
              </CardDescription>
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={total === 0}>
              <DownloadIcon data-icon="inline-start" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <Field className="lg:flex-1">
              <FieldLabel htmlFor="audit-search">Search</FieldLabel>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="audit-search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Actor, action, entity, IP, request ID…"
                  className="pl-8"
                />
              </div>
            </Field>
            <Field className="lg:w-52">
              <FieldLabel>Action</FieldLabel>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger>
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All actions</SelectItem>
                    {actions.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="lg:w-48">
              <FieldLabel>Entity</FieldLabel>
              <Select value={entityType} onValueChange={setEntityType}>
                <SelectTrigger>
                  <SelectValue placeholder="All entities" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All entities</SelectItem>
                    {entityTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="lg:w-40">
              <FieldLabel>Result</FieldLabel>
              <Select value={result} onValueChange={setResult}>
                <SelectTrigger>
                  <SelectValue placeholder="All results" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All results</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failure">Failure</SelectItem>
                    <SelectItem value="denied">Denied</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {error ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleXIcon />
                </EmptyMedia>
                <EmptyTitle>Unable to load the audit log</EmptyTitle>
                <EmptyDescription>Please retry in a moment.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : isLoading && entries.length === 0 ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>No audit entries</EmptyTitle>
                <EmptyDescription>No operations match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const meta = RESULT_META[entry.result]
                    return (
                      <TableRow
                        key={entry.id}
                        className="cursor-pointer"
                        onClick={() => setSelected(entry)}
                      >
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {formatTimestamp(entry.createdAt)}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex flex-col">
                            <span className="font-medium">{entry.actorName ?? "System"}</span>
                            {entry.actorEmail ? (
                              <span className="text-xs text-muted-foreground">{entry.actorEmail}</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.action}</code>
                        </TableCell>
                        <TableCell className="text-sm">
                          {entry.entityType ? (
                            <div className="flex flex-col">
                              <span>{entry.entityLabel ?? entry.entityType}</span>
                              <span className="text-xs text-muted-foreground">
                                {entry.entityType}
                                {entry.entityId ? ` #${entry.entityId}` : ""}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={meta.variant}>
                            <meta.Icon data-icon="inline-start" />
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {entry.ipAddress ?? "—"}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AuditDetailDialog entry={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function AuditDetailDialog({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  return (
    <Dialog open={entry != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit entry</DialogTitle>
          <DialogDescription>
            {entry ? (
              <>
                <code className="text-xs">{entry.action}</code> · {formatTimestamp(entry.createdAt)}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          <ScrollArea className="max-h-[60vh]">
            <FieldGroup className="pr-4">
              <DetailRow label="Actor" value={entry.actorName ? `${entry.actorName}${entry.actorEmail ? ` (${entry.actorEmail})` : ""}` : "System"} />
              <DetailRow label="Actor role" value={entry.actorRole} />
              <DetailRow label="Tenant" value={entry.tenantId != null ? String(entry.tenantId) : "Platform-wide"} />
              <DetailRow label="Result" value={RESULT_META[entry.result].label} />
              <DetailRow label="Entity" value={entry.entityType ? `${entry.entityType}${entry.entityId ? ` #${entry.entityId}` : ""}` : null} />
              <DetailRow label="Entity label" value={entry.entityLabel} />
              <DetailRow label="IP address" value={entry.ipAddress} />
              <DetailRow label="Device / user agent" value={entry.userAgent} mono />
              <DetailRow label="Session ID" value={entry.sessionId} mono />
              <DetailRow label="Request ID" value={entry.requestId} mono />
              <DetailRow label="Integrity hash (SHA-256)" value={entry.integrityHash} mono />
              {entry.before ? <JsonBlock label="Before" value={entry.before} /> : null}
              {entry.after ? <JsonBlock label="After" value={entry.after} /> : null}
              {entry.metadata ? <JsonBlock label="Metadata" value={entry.metadata} /> : null}
            </FieldGroup>
          </ScrollArea>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  if (!value) return null
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <span className={mono ? "break-all font-mono text-xs text-muted-foreground" : "text-sm"}>{value}</span>
    </Field>
  )
}

function JsonBlock({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Field>
  )
}
