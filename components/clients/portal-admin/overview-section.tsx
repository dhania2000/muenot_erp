"use client"

import { Button } from "@/components/ui/button"
import {
  BarChart,
  FunnelChart,
  KpiCard,
  LineChart,
  Panel,
  SectionHeader,
} from "./shared"
import {
  ACTIVE_USERS_TREND,
  ADOPTION_TREND,
  APPROVAL_TREND,
  KPIS,
  LOGIN_ACTIVITY,
  ONBOARDING_FUNNEL,
  RECENT_EVENTS,
  RESOURCE_USAGE,
} from "./data"
import type { AdminSectionKey } from "./portal-admin-console"
import {
  ClipboardCheck,
  FileClock,
  LogIn,
  Rocket,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react"

const QUICK_ACTIONS: { label: string; icon: typeof UserPlus; target: AdminSectionKey }[] = [
  { label: "Create Portal Account", icon: UserPlus, target: "directory" },
  { label: "Invite Client", icon: Users, target: "invitations" },
  { label: "Review Applications", icon: ClipboardCheck, target: "applications" },
  { label: "Manage Access", icon: ShieldCheck, target: "access" },
  { label: "Configure Onboarding", icon: Rocket, target: "onboarding" },
  { label: "Portal Settings", icon: Settings2, target: "settings" },
  { label: "View Audit Logs", icon: FileClock, target: "activity" },
]

const EVENT_ICON = {
  login: LogIn,
  approve: ClipboardCheck,
  invite: UserPlus,
  document: FileClock,
  access: ShieldCheck,
  user: Users,
  security: ShieldCheck,
} as const

export function OverviewSection({ onNavigate }: { onNavigate: (key: AdminSectionKey) => void }) {
  return (
    <div className="grid gap-5">
      <SectionHeader
        title="Client Portal Overview"
        description="Executive summary of portal adoption, access and activity across all client organisations."
        actions={
          <Button size="sm" onClick={() => onNavigate("directory")}>
            <UserPlus className="size-4" /> Create Portal Account
          </Button>
        }
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {KPIS.map((k) => (
          <KpiCard key={k.key} label={k.label} value={k.value} delta={k.delta} tone={k.tone} />
        ))}
      </div>

      {/* Quick actions */}
      <Panel title="Quick actions">
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a) => (
            <Button key={a.label} variant="outline" size="sm" onClick={() => onNavigate(a.target)}>
              <a.icon className="size-4" /> {a.label}
            </Button>
          ))}
        </div>
      </Panel>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Portal adoption" description="Onboarded client organisations">
          <LineChart data={ADOPTION_TREND} />
        </Panel>
        <Panel title="Active users trend" description="Monthly active portal users">
          <LineChart data={ACTIVE_USERS_TREND} />
        </Panel>
        <Panel title="Login activity" description="Logins over the last 7 days">
          <BarChart data={LOGIN_ACTIVITY} />
        </Panel>
        <Panel title="Resource usage" description="Portal record views this month">
          <BarChart data={RESOURCE_USAGE} />
        </Panel>
        <Panel title="Onboarding funnel" description="Self-registration conversion">
          <FunnelChart data={ONBOARDING_FUNNEL} />
        </Panel>
        <Panel title="Approval trend" description="Applications approved per month">
          <BarChart data={APPROVAL_TREND} />
        </Panel>
      </div>

      {/* Recent events */}
      <Panel
        title="Recent portal events"
        actions={
          <Button variant="ghost" size="sm" onClick={() => onNavigate("activity")}>
            View all
          </Button>
        }
      >
        <ul className="grid gap-1">
          {RECENT_EVENTS.map((e) => {
            const Icon = EVENT_ICON[e.kind]
            return (
              <li key={e.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <p className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{e.actor}</span>{" "}
                  <span className="text-muted-foreground">{e.action}</span>{" "}
                  <span className="font-medium">{e.target}</span>
                </p>
                <span className="shrink-0 text-xs text-muted-foreground">{e.at}</span>
              </li>
            )
          })}
        </ul>
      </Panel>
    </div>
  )
}
