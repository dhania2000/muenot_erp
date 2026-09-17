"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, MailOpen, MousePointerClick, Send, AlertTriangle, UserX } from "lucide-react"

const RECIPIENT_BADGE: Record<string, string> = {
  Sent: "bg-blue-100 text-blue-700",
  Delivered: "bg-blue-100 text-blue-700",
  Opened: "bg-emerald-100 text-emerald-700",
  Clicked: "bg-violet-100 text-violet-700",
  Bounced: "bg-red-100 text-red-700",
  Failed: "bg-red-100 text-red-700",
  Unsubscribed: "bg-amber-100 text-amber-700",
  Skipped: "bg-muted text-muted-foreground",
  Queued: "bg-muted text-muted-foreground",
}

function pct(n: number, d: number) {
  if (!d) return "0%"
  return `${Math.round((n / d) * 1000) / 10}%`
}

function Metric({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

export function EmailCampaignDetail({
  campaignId,
  open,
  onOpenChange,
}: {
  campaignId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isLoading } = useSWR<{ analytics: any; timeline: any[]; topLinks: any[] }>(
    open && campaignId ? `/api/marketing/campaigns/${campaignId}/analytics` : null,
    fetcher,
    { refreshInterval: open ? 8000 : 0 },
  )
  // The report header (name/subject/status) comes from the campaign record.
  const { data: campaignData } = useSWR<{ campaign: any }>(
    open && campaignId ? `/api/marketing/campaigns/${campaignId}` : null,
    fetcher,
    { refreshInterval: open ? 8000 : 0 },
  )
  const [status, setStatus] = useState<string>("all")
  const recipQuery = open && campaignId ? `/api/marketing/campaigns/${campaignId}/recipients?status=${status}&limit=200` : null
  const { data: recipData, isLoading: recipLoading } = useSWR<{ recipients: any[] }>(recipQuery, fetcher, {
    refreshInterval: open ? 8000 : 0,
  })

  const c = campaignData?.campaign
  const a = data?.analytics
  const topLinks = data?.topLinks || []
  const sent = a?.sent ?? 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <SheetTitle>{c?.name || "Campaign report"}</SheetTitle>
            {c?.status ? <Badge variant="secondary">{c.status}</Badge> : null}
          </div>
          <SheetDescription>{c?.subject}</SheetDescription>
        </SheetHeader>

        {isLoading || !a ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <Tabs defaultValue="overview" className="w-full">
              <div className="border-b px-6 pt-4">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="recipients">Recipients</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview" className="space-y-4 px-6 py-4">
                <div className="grid grid-cols-2 gap-3">
                  <Metric icon={Send} label="Sent" value={sent} sub={`of ${a.recipients ?? 0} recipients`} />
                  <Metric icon={MailOpen} label="Opened" value={a.openedUnique ?? 0} sub={pct(a.openedUnique ?? 0, sent) + " open rate"} />
                  <Metric icon={MousePointerClick} label="Clicked" value={a.clickedUnique ?? 0} sub={pct(a.clickedUnique ?? 0, sent) + " click rate"} />
                  <Metric icon={AlertTriangle} label="Bounced" value={a.bounced ?? 0} sub={pct(a.bounced ?? 0, sent) + " bounce rate"} />
                  <Metric icon={UserX} label="Unsubscribed" value={a.unsubscribed ?? 0} />
                  <Metric icon={AlertTriangle} label="Failed" value={a.failed ?? 0} />
                </div>

                <Separator />

                <div className="space-y-2 text-sm">
                  <Row label="Queued / remaining" value={a.queued ?? 0} />
                  <Row label="Unique opens" value={a.openedUnique ?? 0} />
                  <Row label="Total opens" value={a.opensTotal ?? 0} />
                  <Row label="Total clicks" value={a.clicksTotal ?? 0} />
                  {c?.started_at ? <Row label="Started" value={new Date(c.started_at).toLocaleString()} /> : null}
                  {c?.completed_at ? <Row label="Completed" value={new Date(c.completed_at).toLocaleString()} /> : null}
                </div>

                {topLinks.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="mb-2 text-sm font-medium">Top links</h4>
                      <div className="space-y-1.5">
                        {topLinks.map((l: any, i: number) => (
                          <div key={i} className="flex items-center justify-between gap-3 text-sm">
                            <span className="truncate text-muted-foreground">{l.url}</span>
                            <Badge variant="outline">{l.clicks}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="recipients" className="px-6 py-4">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {["all", "Opened", "Clicked", "Sent", "Bounced", "Failed", "Unsubscribed"].map((s) => (
                    <button key={s} type="button" onClick={() => setStatus(s)}
                      className={`rounded-full border px-3 py-1 text-xs capitalize transition ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}>
                      {s}
                    </button>
                  ))}
                </div>
                {recipLoading ? (
                  <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Contact</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Opens</TableHead>
                        <TableHead className="text-right">Clicks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(recipData?.recipients || []).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            <div className="font-medium">{r.name || r.email}</div>
                            <div className="text-xs text-muted-foreground">{r.email}</div>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${RECIPIENT_BADGE[r.status] || "bg-muted text-muted-foreground"}`}>
                              {r.status}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.open_count || 0}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.click_count || 0}</TableCell>
                        </TableRow>
                      ))}
                      {(recipData?.recipients || []).length === 0 && (
                        <TableRow><TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">No recipients in this view yet.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}
