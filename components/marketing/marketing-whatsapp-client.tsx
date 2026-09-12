"use client"

import * as React from "react"
import useSWR from "swr"
import {
  MessageCircle,
  ExternalLink,
  Loader2,
  LayoutDashboard,
  Inbox as InboxIcon,
  Users,
  Building2,
  UserCog,
  FileText,
  Megaphone,
  Workflow,
  BarChart3,
  Settings as SettingsIcon,
} from "lucide-react"

import { MarketingHeader } from "@/components/marketing/marketing-shared"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { fetcher } from "@/lib/fetcher"
import { WhatsAppInbox } from "@/components/marketing/whatsapp-inbox"
import { WhatsAppEmbeddedSignup } from "@/components/marketing/whatsapp-embedded-signup"
import { WhatsAppConnectionBadge } from "@/components/marketing/whatsapp/connection-badge"
import { OverviewTab } from "@/components/marketing/whatsapp/overview-tab"
import { ContactsTab } from "@/components/marketing/whatsapp/contacts-tab"
import { DepartmentsTab } from "@/components/marketing/whatsapp/departments-tab"
import { AgentsTab } from "@/components/marketing/whatsapp/agents-tab"
import { TemplatesTab } from "@/components/marketing/whatsapp/templates-tab"
import { CampaignsTab } from "@/components/marketing/whatsapp/campaigns-tab"
import { AutomationsTab } from "@/components/marketing/whatsapp/automations-tab"
import { AnalyticsTab } from "@/components/marketing/whatsapp/analytics-tab"
import { SettingsTab } from "@/components/marketing/whatsapp/settings-tab"
import { IntegrateManuallyDialog } from "@/components/marketing/whatsapp/integrate-dialog"
import type { StatusResponse } from "@/components/marketing/whatsapp/types"

/**
 * WhatsApp multi-agent workspace shell.
 *
 * Ten-tab layout (Overview, Inbox, Contacts, Departments, Agents, Templates,
 * Campaigns, Automations, Analytics, Settings). Connection state and the
 * caller's effective capabilities come from /status (never hardcoded), so the
 * header badge reflects the real Cloud API health.
 */

const TABS = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "inbox", label: "Inbox", icon: InboxIcon },
  { value: "contacts", label: "Contacts", icon: Users },
  { value: "departments", label: "Departments", icon: Building2 },
  { value: "agents", label: "Agents", icon: UserCog },
  { value: "templates", label: "Templates", icon: FileText },
  { value: "campaigns", label: "Campaigns", icon: Megaphone },
  { value: "automations", label: "Automations", icon: Workflow },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "settings", label: "Settings", icon: SettingsIcon },
] as const

export function MarketingWhatsAppClient() {
  const { data, isLoading, mutate } = useSWR<StatusResponse>(
    "/api/marketing/whatsapp/status",
    fetcher,
    { refreshInterval: 60_000 },
  )
  const [tab, setTab] = React.useState<string>("overview")

  const health = data?.health ?? null
  const caps = data?.caps ?? null
  const role = data?.role ?? "employee"
  const connected = health?.connected ?? false

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Messaging"
        title="WhatsApp"
        description="One business number, many agents. Shared inbox, department routing, templates, campaigns and automations on the WhatsApp Cloud API."
        action={health ? <WhatsAppConnectionBadge health={health} /> : null}
      />

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking WhatsApp connection…
          </CardContent>
        </Card>
      ) : !connected ? (
        <NotConnected onConnected={() => mutate()} />
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="gap-6">
          <div className="-mx-1 overflow-x-auto px-1">
            <TabsList className="h-auto flex-nowrap">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="gap-1.5 px-3 py-1.5">
                  <t.icon className="size-4" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview">
            <OverviewTab health={health} caps={caps} onGoToTab={setTab} onRefresh={() => mutate()} />
          </TabsContent>
          <TabsContent value="inbox">
            <WhatsAppInbox />
          </TabsContent>
          <TabsContent value="contacts">
            <ContactsTab caps={caps} />
          </TabsContent>
          <TabsContent value="departments">
            <DepartmentsTab caps={caps} />
          </TabsContent>
          <TabsContent value="agents">
            <AgentsTab role={role} />
          </TabsContent>
          <TabsContent value="templates">
            <TemplatesTab />
          </TabsContent>
          <TabsContent value="campaigns">
            <CampaignsTab caps={caps} />
          </TabsContent>
          <TabsContent value="automations">
            <AutomationsTab caps={caps} />
          </TabsContent>
          <TabsContent value="analytics">
            <AnalyticsTab caps={caps} />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab role={role} onChanged={() => mutate()} />
          </TabsContent>
        </Tabs>
      )}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Not-connected state                                                 */
/* ------------------------------------------------------------------ */

const PREREQUISITES: string[] = [
  "Keep using the WhatsApp Business App on the number you want to connect — coexistence onboarding preserves that number, its chats and its app; it never replaces or deregisters it.",
  "Have the phone with the WhatsApp Business App handy: you will scan a QR code from within the app (Settings → Linked devices) to finish connecting.",
  "Sign in with the Meta (Facebook) account that manages, or can create, the WhatsApp Business Account for this number when the guided popup asks.",
]

function NotConnected({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-[#25D366]/10">
            <MessageCircle className="size-8 text-[#25D366]" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight">Connect your WhatsApp Business number</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">
              Run Meta&apos;s coexistence onboarding to bring your number into the ERP shared inbox. The WhatsApp
              Business App keeps working on the same number — there is no registration step or PIN.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <WhatsAppEmbeddedSignup onConnected={onConnected} />
            <IntegrateManuallyDialog onConnected={onConnected} />
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Learn more
              <ExternalLink className="size-4" />
            </a>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prerequisites</CardTitle>
          <CardDescription>Make sure the following are ready before you connect.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-4">
            {PREREQUISITES.map((text, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{text}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
