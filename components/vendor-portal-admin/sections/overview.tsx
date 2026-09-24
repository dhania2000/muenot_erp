"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  OVERVIEW_KPIS,
  ONBOARDING_FUNNEL,
  ACTIVITY_TREND,
  ADOPTION,
  COMPLIANCE_BREAKDOWN,
  RECENT_EVENTS,
} from "@/lib/vendor-portal/admin-data"
import {
  KpiCard,
  BarList,
  Sparkbars,
  DonutStat,
  StatusBadge,
  Panel,
  fmtDateTime,
} from "@/components/vendor-portal-admin/shared"
import {
  UserPlus,
  Send,
  ClipboardCheck,
  FileCheck2,
  ShieldCheck,
  Settings2,
  ScrollText,
  SlidersHorizontal,
} from "lucide-react"
import type { ConsoleSection } from "@/components/vendor-portal-admin/vendor-portal-admin"

const QUICK_ACTIONS: { label: string; icon: React.ElementType; go?: ConsoleSection }[] = [
  { label: "Create Vendor Account", icon: UserPlus, go: "directory" },
  { label: "Invite Vendor", icon: Send, go: "invitations" },
  { label: "Review Applications", icon: ClipboardCheck, go: "applications" },
  { label: "Review Documents", icon: FileCheck2, go: "documents" },
  { label: "Manage Access", icon: ShieldCheck, go: "access" },
  { label: "Configure Onboarding", icon: SlidersHorizontal, go: "onboarding" },
  { label: "Portal Settings", icon: Settings2, go: "settings" },
  { label: "Audit Logs", icon: ScrollText, go: "audit" },
]

export function OverviewSection({ onNavigate }: { onNavigate: (s: ConsoleSection) => void }) {
  return (
    <div className="grid gap-5">
      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {QUICK_ACTIONS.map((a) => (
          <Button
            key={a.label}
            variant="outline"
            size="sm"
            onClick={() => a.go && onNavigate(a.go)}
            className="gap-1.5"
          >
            <a.icon data-icon="inline-start" className="size-4" />
            {a.label}
          </Button>
        ))}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {OVERVIEW_KPIS.map((k) => (
          <KpiCard key={k.key} label={k.label} value={k.value} delta={k.delta} tone={k.tone} />
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Onboarding funnel</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={ONBOARDING_FUNNEL.map((s) => ({ label: s.stage, value: s.value }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Vendor activity trend</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Portal logins</p>
              <Sparkbars data={ACTIVITY_TREND.map((m) => ({ label: m.month, value: m.logins }))} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Invoice submissions</p>
              <Sparkbars data={ACTIVITY_TREND.map((m) => ({ label: m.month, value: m.submissions }))} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Portal adoption</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutStat segments={ADOPTION} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending compliance</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutStat segments={COMPLIANCE_BREAKDOWN} />
          </CardContent>
        </Card>
      </div>

      {/* Recent events */}
      <Panel className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent portal events</h3>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("audit")}>
            View audit logs
          </Button>
        </div>
        <ul className="grid gap-1">
          {RECENT_EVENTS.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-muted/40"
            >
              <div className="grid gap-0.5">
                <span className="text-sm">{e.action}</span>
                <span className="text-xs text-muted-foreground">
                  {e.vendor} · {e.actor}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {e.tone && e.tone !== "default" ? (
                  <StatusBadge status={e.tone === "success" ? "verified" : e.tone === "danger" ? "rejected" : "pending"} label={e.tone} />
                ) : null}
                <span className="text-xs text-muted-foreground">{fmtDateTime(e.time)}</span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
