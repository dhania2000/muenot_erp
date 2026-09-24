"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import {
  Share2,
  Link2,
  Lock,
  Clock,
  Eye,
  Download,
  Copy,
  Ban,
  RefreshCw,
  Loader2,
  ShieldCheck,
  ScrollText,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { recipientTypeLabel, shareTokenValid } from "@/lib/dms/model"
import type { DmsShare, DmsAuditEntry } from "@/lib/dms/types"
import { cn } from "@/lib/utils"

type ShareRow = DmsShare & { url?: string }
type ConsoleResponse = { shares: ShareRow[]; audit: DmsAuditEntry[]; isAdmin: boolean }

type StatusFilter = "all" | "active" | "expired" | "revoked"

function shareStatus(s: DmsShare): Exclude<StatusFilter, "all"> {
  if (s.revokedAt) return "revoked"
  if (!shareTokenValid({ expiresAt: s.expiresAt, revokedAt: null })) return "expired"
  return "active"
}

const statusStyles: Record<Exclude<StatusFilter, "all">, string> = {
  active: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  expired: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  revoked: "bg-destructive/10 text-destructive border-destructive/20",
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString()
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

const auditLabels: Record<string, string> = {
  share: "Link created",
  revoke_share: "Link revoked",
  share_view: "Viewed",
  share_download: "Downloaded",
  share_unlock: "Password accepted",
  share_unlock_failed: "Wrong password",
  share_denied: "Access denied",
}

function KpiCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Share2; tone?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className={cn("inline-flex size-9 items-center justify-center rounded-lg bg-muted text-primary", tone)}>
          <Icon className="size-4" />
        </span>
        <div>
          <div className="text-2xl font-semibold leading-none">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

export function DocumentSharingConsole() {
  const { data, isLoading, mutate } = useSWR<ConsoleResponse>("/api/dms/shares", fetcher)
  const [status, setStatus] = useState<StatusFilter>("all")
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<number | null>(null)
  const [revoking, setRevoking] = useState<number | null>(null)

  const shares = data?.shares ?? []
  const audit = data?.audit ?? []

  const kpis = useMemo(() => {
    let active = 0
    let expired = 0
    let revoked = 0
    let views = 0
    let downloads = 0
    for (const s of shares) {
      const st = shareStatus(s)
      if (st === "active") active++
      else if (st === "expired") expired++
      else revoked++
      views += s.viewCount
      downloads += s.downloadCount
    }
    return { active, expired, revoked, views, downloads }
  }, [shares])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return shares.filter((s) => {
      if (status !== "all" && shareStatus(s) !== status) return false
      if (needle) {
        const hay = `${s.documentTitle ?? ""} ${s.docRef ?? ""} ${s.label ?? ""} ${s.recipient ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [shares, status, q])

  const auditForSelected = useMemo(() => {
    if (selected == null) return audit
    return audit.filter((a) => a.shareId === selected)
  }, [audit, selected])

  async function revoke(shareId: number) {
    setRevoking(shareId)
    try {
      const res = await fetch(`/api/dms/shares?shareId=${shareId}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not revoke link")
      toast.success("Link revoked")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRevoking(null)
    }
  }

  function copy(url?: string) {
    if (!url) return
    navigator.clipboard?.writeText(url).then(
      () => toast.success("Link copied"),
      () => toast.error("Could not copy"),
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <Share2 className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 89</span>
            <h1 className="text-xl font-semibold">Document Sharing</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Signed, controllable share links for internal users, teams and external parties — with expiry, password
              protection, download limits and a full access audit trail.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => mutate()} className="shrink-0">
          <RefreshCw className="mr-1.5 size-4" /> Refresh
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Active" value={kpis.active} icon={ShieldCheck} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
        <KpiCard label="Expired" value={kpis.expired} icon={Clock} tone="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
        <KpiCard label="Revoked" value={kpis.revoked} icon={Ban} tone="bg-destructive/10 text-destructive" />
        <KpiCard label="Views" value={kpis.views} icon={Eye} />
        <KpiCard label="Downloads" value={kpis.downloads} icon={Download} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="expired">Expired</TabsTrigger>
            <TabsTrigger value="revoked">Revoked</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          placeholder="Search by document, label or recipient…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" /> Share links
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {shares.length === 0 ? "No shared links yet." : "No links match this filter."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">Usage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s) => {
                    const st = shareStatus(s)
                    return (
                      <TableRow
                        key={s.id}
                        onClick={() => setSelected((cur) => (cur === s.id ? null : s.id))}
                        className={cn("cursor-pointer", selected === s.id && "bg-muted/50")}
                      >
                        <TableCell>
                          <div className="font-medium">{s.documentTitle ?? s.docRef ?? `Document ${s.documentId}`}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.docRef}
                            {s.label ? ` · ${s.label}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{recipientTypeLabel(s.recipientType)}</div>
                          {s.recipient && <div className="text-xs text-muted-foreground">{s.recipient}</div>}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className="capitalize">
                              {s.access === "download" ? "Download" : "View only"}
                            </Badge>
                            {s.hasPassword && (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Lock className="size-3" /> Password
                              </span>
                            )}
                          </div>
                          {s.maxDownloads != null && (
                            <div className="text-xs text-muted-foreground">Max {s.maxDownloads} downloads</div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {s.expiresAt ? formatDate(s.expiresAt) : "Never"}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          <div>{s.viewCount} views</div>
                          <div className="text-xs text-muted-foreground">{s.downloadCount} downloads</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("capitalize", statusStyles[st])}>
                            {st}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => copy(s.url)}
                              aria-label="Copy link"
                              disabled={st !== "active"}
                            >
                              <Copy className="size-4" />
                            </Button>
                            {st !== "revoked" && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button size="icon" variant="ghost" aria-label="Revoke link" disabled={revoking === s.id}>
                                    {revoking === s.id ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <Ban className="size-4 text-destructive" />
                                    )}
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Revoke this share link?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      The link will stop working immediately for everyone who holds it. This cannot be
                                      undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => revoke(s.id)}>Revoke link</AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="size-4" /> Access audit
            {selected != null && (
              <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setSelected(null)}>
                Show all
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {auditForSelected.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {selected != null ? "No recorded access for this link yet." : "No access recorded yet."}
            </p>
          ) : (
            <ol className="space-y-3">
              {auditForSelected.slice(0, 100).map((a) => (
                <li key={a.id} className="flex gap-3 text-sm">
                  <div className="mt-1 size-2 shrink-0 rounded-full bg-primary/60" />
                  <div className="min-w-0">
                    <div className="font-medium">{auditLabels[a.action] ?? a.action.replace(/_/g, " ")}</div>
                    {a.detail && <div className="truncate text-xs text-muted-foreground">{a.detail}</div>}
                    <div className="text-xs text-muted-foreground">
                      {a.userId ? `User ${a.userId} · ` : "Anonymous · "}
                      {formatDateTime(a.createdAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
