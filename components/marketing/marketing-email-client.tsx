"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Plus,
  Search,
  Mail,
  Send,
  MailOpen,
  MousePointerClick,
  MoreHorizontal,
  RefreshCw,
  BarChart3,
  Pencil,
  Copy,
  Trash2,
  Pause,
  Play,
  Ban,
  Loader2,
} from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { EmailCampaignBuilder } from "@/components/marketing/email-campaign-builder"
import { EmailCampaignDetail } from "@/components/marketing/email-campaign-detail"

const STATUS_BADGE: Record<string, string> = {
  Draft: "bg-muted text-muted-foreground",
  Scheduled: "bg-amber-100 text-amber-700",
  Sending: "bg-blue-100 text-blue-700",
  Paused: "bg-orange-100 text-orange-700",
  Sent: "bg-emerald-100 text-emerald-700",
  Failed: "bg-red-100 text-red-700",
  Cancelled: "bg-muted text-muted-foreground",
}

const STATUSES = ["all", "Draft", "Scheduled", "Sending", "Paused", "Sent", "Failed", "Cancelled"]

function pct(n: number, d: number) {
  if (!d) return "—"
  return `${Math.round((n / d) * 1000) / 10}%`
}

export function MarketingEmailClient() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [builderId, setBuilderId] = useState<number | null>(null)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")

  const params = new URLSearchParams()
  if (status !== "all") params.set("status", status)
  if (search.trim()) params.set("search", search.trim())
  const key = `/api/marketing/campaigns?${params.toString()}`
  const { data, isLoading, mutate } = useSWR<{ campaigns: any[]; stats: any }>(key, fetcher, {
    refreshInterval: 10000,
  })

  const campaigns = data?.campaigns || []
  const stats = data?.stats || {}

  async function createCampaign() {
    if (!newName.trim()) {
      toast.error("Give your campaign a name")
      return
    }
    setCreating(true)
    try {
      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not create campaign")
      setNewName("")
      await mutate()
      // Open the builder on the new draft.
      setBuilderId(body.campaign.id)
      setBuilderOpen(true)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function runAction(id: number, action: string, label: string) {
    const res = await fetch(`/api/marketing/campaigns/${id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(body.error || "Action failed")
    else {
      toast.success(label)
      mutate()
    }
  }

  async function duplicate(id: number) {
    const res = await fetch(`/api/marketing/campaigns/${id}/duplicate`, { method: "POST" })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(body.error || "Could not duplicate")
    else {
      toast.success("Duplicated as a new draft")
      mutate()
    }
  }

  async function confirmDelete() {
    if (!deleteId) return
    const res = await fetch(`/api/marketing/campaigns/${deleteId}`, { method: "DELETE" })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(body.error || "Could not delete")
    else {
      toast.success("Campaign deleted")
      mutate()
    }
    setDeleteId(null)
  }

  function openBuilder(id: number) {
    setBuilderId(id)
    setBuilderOpen(true)
  }
  function openDetail(id: number) {
    setDetailId(id)
    setDetailOpen(true)
  }

  const totalSent = Number(stats.total_sent || 0)
  const totalOpened = Number(stats.total_opened || 0)
  const totalClicked = Number(stats.total_clicked || 0)

  return (
    <div className="space-y-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Email Campaigns"
        description="Design, target, and send email campaigns to your contacts — then track opens, clicks, and unsubscribes in real time."
        action={
          <Dialog>
            <DropdownMenu>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
                  <RefreshCw className="size-4" />
                </Button>
                <CreateButton value={newName} onChange={setNewName} onCreate={createCampaign} creating={creating} />
              </div>
            </DropdownMenu>
          </Dialog>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total campaigns" value={Number(stats.total || 0)} icon={Mail} hint={`${Number(stats.sending || 0)} sending now`} />
        <StatCard label="Emails sent" value={totalSent.toLocaleString()} icon={Send} hint={`${Number(stats.scheduled || 0)} scheduled`} />
        <StatCard label="Avg. open rate" value={pct(totalOpened, totalSent)} icon={MailOpen} hint={`${totalOpened.toLocaleString()} opens`} />
        <StatCard label="Avg. click rate" value={pct(totalClicked, totalSent)} icon={MousePointerClick} hint={`${totalClicked.toLocaleString()} clicks`} />
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search campaigns…" className="pl-9" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s === "all" ? "All statuses" : s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Opens</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="py-16 text-center"><Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" /></TableCell></TableRow>
              ) : campaigns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-16 text-center">
                    <Mail className="mx-auto mb-3 size-8 text-muted-foreground" />
                    <p className="text-sm font-medium">No campaigns yet</p>
                    <p className="text-sm text-muted-foreground">Create your first email campaign to get started.</p>
                  </TableCell>
                </TableRow>
              ) : (
                campaigns.map((c) => {
                  const sent = Number(c.sent_count || 0)
                  const canReport = ["Sending", "Paused", "Sent", "Failed", "Cancelled"].includes(c.status)
                  return (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => (canReport ? openDetail(c.id) : openBuilder(c.id))}>
                      <TableCell>
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.campaign_code} · {c.type}
                          {c.subject ? ` · ${c.subject}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[c.status] || "bg-muted"}`}>
                          {c.status}
                          {c.status === "Sending" ? ` ${sent}/${c.recipient_count}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(c.recipient_count || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{sent ? pct(Number(c.opened_count || 0), sent) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{sent ? pct(Number(c.clicked_count || 0), sent) : "—"}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8"><MoreHorizontal className="size-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canReport && (
                              <DropdownMenuItem onClick={() => openDetail(c.id)}><BarChart3 className="mr-2 size-4" />View report</DropdownMenuItem>
                            )}
                            {["Draft", "Scheduled", "Paused"].includes(c.status) && (
                              <DropdownMenuItem onClick={() => openBuilder(c.id)}><Pencil className="mr-2 size-4" />Edit</DropdownMenuItem>
                            )}
                            {c.status === "Scheduled" && (
                              <DropdownMenuItem onClick={() => runAction(c.id, "unschedule", "Moved back to draft")}><Ban className="mr-2 size-4" />Unschedule</DropdownMenuItem>
                            )}
                            {c.status === "Sending" && (
                              <DropdownMenuItem onClick={() => runAction(c.id, "pause", "Campaign paused")}><Pause className="mr-2 size-4" />Pause</DropdownMenuItem>
                            )}
                            {c.status === "Paused" && (
                              <DropdownMenuItem onClick={() => runAction(c.id, "resume", "Campaign resumed")}><Play className="mr-2 size-4" />Resume</DropdownMenuItem>
                            )}
                            {["Sending", "Paused", "Scheduled"].includes(c.status) && (
                              <DropdownMenuItem onClick={() => runAction(c.id, "cancel", "Campaign cancelled")}><Ban className="mr-2 size-4" />Cancel</DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => duplicate(c.id)}><Copy className="mr-2 size-4" />Duplicate</DropdownMenuItem>
                            {["Draft", "Cancelled", "Failed"].includes(c.status) && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-red-600" onClick={() => setDeleteId(c.id)}><Trash2 className="mr-2 size-4" />Delete</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <EmailCampaignBuilder campaignId={builderId} open={builderOpen} onOpenChange={setBuilderOpen} onSaved={() => mutate()} />
      <EmailCampaignDetail campaignId={detailId} open={detailOpen} onOpenChange={setDetailOpen} />

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this campaign?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the draft campaign and its content. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CreateButton({
  value,
  onChange,
  onCreate,
  creating,
}: {
  value: string
  onChange: (v: string) => void
  onCreate: () => void
  creating: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}><Plus className="mr-2 size-4" />New campaign</Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New email campaign</DialogTitle>
          <DialogDescription>Name your campaign — you can set the content, audience, and schedule next.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="cname">Campaign name</Label>
          <Input id="cname" value={value} autoFocus placeholder="e.g. October Product Newsletter"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) onCreate()
            }} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={onCreate} disabled={creating}>
            {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Create &amp; edit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
