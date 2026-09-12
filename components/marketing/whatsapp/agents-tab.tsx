"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TabState } from "./shared"
import { fetcher } from "@/lib/fetcher"
import type { AgentProfile } from "./types"

/** Capability flags shown as a per-agent matrix (order = display order). */
const CAP_FIELDS: { key: string; label: string }[] = [
  { key: "is_agent", label: "WhatsApp agent" },
  { key: "is_available", label: "Available" },
  { key: "can_view_all", label: "View all chats" },
  { key: "can_view_department", label: "View dept chats" },
  { key: "can_send", label: "Send messages" },
  { key: "can_assign", label: "Assign" },
  { key: "can_reassign", label: "Reassign / transfer" },
  { key: "can_close", label: "Close chats" },
  { key: "can_send_templates", label: "Send templates" },
  { key: "can_create_campaigns", label: "Create campaigns" },
  { key: "can_view_analytics", label: "View analytics" },
  { key: "can_manage_contacts", label: "Manage contacts" },
  { key: "can_manage_automation", label: "Manage automation" },
]

const CAP_TO_PROFILE: Record<string, string> = {
  can_view_all: "canViewAll",
  can_view_department: "canViewDepartment",
  can_send: "canSend",
  can_assign: "canAssign",
  can_reassign: "canReassign",
  can_close: "canClose",
  can_send_templates: "canSendTemplates",
  can_create_campaigns: "canCreateCampaigns",
  can_view_analytics: "canViewAnalytics",
  can_manage_contacts: "canManageContacts",
  can_manage_automation: "canManageAutomation",
}

export function AgentsTab({ role }: { role: "admin" | "employee" }) {
  const enabled = role === "admin"
  const { data, isLoading, mutate } = useSWR<{ profiles: AgentProfile[] }>(
    enabled ? "/api/marketing/whatsapp/agents/profiles" : null,
    fetcher,
  )

  if (!enabled) return <TabState>Only administrators can manage WhatsApp agents.</TabState>
  if (isLoading) return <TabState loading>Loading agents…</TabState>

  const profiles = data?.profiles ?? []

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Reuse existing ERP users as WhatsApp agents — no separate logins. Toggle each capability to control what an
        agent can do on the shared number.
      </p>
      <div className="flex flex-col gap-4">
        {profiles.map((p) => (
          <AgentRow key={p.userId} profile={p} onSaved={() => mutate()} />
        ))}
      </div>
    </div>
  )
}

function AgentRow({ profile, onSaved }: { profile: AgentProfile; onSaved: () => void }) {
  const [saving, setSaving] = React.useState<string | null>(null)
  const isAdmin = profile.role === "admin"

  function isOn(key: string): boolean {
    if (key === "is_agent") return profile.isAgent
    if (key === "is_available") return profile.isAvailable
    const profileKey = CAP_TO_PROFILE[key]
    return Boolean(profile.caps?.[profileKey])
  }

  async function toggle(key: string, value: boolean) {
    setSaving(key)
    try {
      const res = await fetch("/api/marketing/whatsapp/agents/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: profile.userId, settings: { [key]: value } }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || "Failed to update agent")
      }
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {profile.name}
            {isAdmin ? <Badge variant="secondary">Admin</Badge> : null}
          </CardTitle>
          <div className="flex flex-wrap gap-1">
            {profile.departments.map((d) => (
              <Badge key={d.id} variant="outline" className="text-[10px]">
                {d.name}
                {d.role === "manager" ? " · Mgr" : ""}
              </Badge>
            ))}
          </div>
        </div>
        <CardDescription>{profile.designation || profile.email}</CardDescription>
      </CardHeader>
      <CardContent>
        {isAdmin ? (
          <p className="text-xs text-muted-foreground">Administrators automatically have every WhatsApp capability.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
            {CAP_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={isOn(f.key)}
                  disabled={saving === f.key}
                  onChange={(e) => toggle(f.key, e.target.checked)}
                  className="size-4 rounded border-input"
                />
                <span className="text-pretty">{f.label}</span>
                {saving === f.key ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
