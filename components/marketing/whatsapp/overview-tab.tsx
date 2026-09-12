"use client"

import * as React from "react"
import { CheckCircle2, Phone, BadgeCheck, Gauge, RefreshCw, Loader2, Webhook, FileText } from "lucide-react"
import { toast } from "sonner"

import { StatCard } from "@/components/marketing/marketing-shared"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { StatusDot, formatDateTime } from "./shared"
import type { ConnectionHealth, WhatsAppCaps } from "./types"

/**
 * Overview: real-time connection KPIs + the live diagnostics panel. Every value
 * here comes from the health probe, so it can never show a false "Connected".
 */
export function OverviewTab({
  health,
  caps,
  onGoToTab,
  onRefresh,
}: {
  health: ConnectionHealth | null
  caps: WhatsAppCaps | null
  onGoToTab: (tab: string) => void
  onRefresh: () => void
}) {
  const [refreshing, setRefreshing] = React.useState(false)
  if (!health) return null

  const phone = health.phone
  const number = phone?.displayPhoneNumber || health.integration?.displayPhoneNumber || "—"
  const name = phone?.verifiedName || health.integration?.verifiedName || health.integration?.businessName || "WhatsApp Business"

  async function refresh() {
    setRefreshing(true)
    try {
      await fetch("/api/marketing/whatsapp/status", { cache: "no-store" })
      onRefresh()
      toast.success("Connection re-checked")
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Status" value={statusLabel(health.overall)} icon={CheckCircle2} />
        <StatCard label="Business Number" value={number} icon={Phone} />
        <StatCard label="Verified Name" value={name} icon={BadgeCheck} />
        <StatCard label="Quality Rating" value={phone?.qualityRating ?? "Unknown"} icon={Gauge} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Connection diagnostics</CardTitle>
            <CardDescription>Live Cloud API + webhook health, checked {formatDateTime(health.checkedAt)}.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {health.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
              <StatusDot status={c.status} />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{c.label}</span>
                <span className="text-xs text-muted-foreground text-pretty">{c.detail}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Webhook className="size-4" /> Webhook
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Row label="Last event" value={formatDateTime(health.webhook.lastEventAt)} />
            <Row label="Events (24h)" value={String(health.webhook.eventsLast24h)} />
            <Row label="Last error" value={health.webhook.lastError ?? "None"} />
            <p className="mt-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {health.webhookUrl}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" /> Templates
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <Row label="Approved" value={String(health.templates.approved)} />
            <Row label="Total" value={String(health.templates.total)} />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => onGoToTab("inbox")}>
                Open inbox
              </Button>
              {caps?.canCreateCampaigns ? (
                <Button variant="outline" size="sm" onClick={() => onGoToTab("campaigns")}>
                  New campaign
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => onGoToTab("settings")}>
                Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-pretty">{value}</span>
    </div>
  )
}

function statusLabel(overall: ConnectionHealth["overall"]): string {
  return { healthy: "Connected", degraded: "Degraded", down: "Disconnected", disconnected: "Not connected" }[overall]
}
