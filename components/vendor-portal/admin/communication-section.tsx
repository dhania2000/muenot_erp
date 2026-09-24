"use client"

import { useState } from "react"
import { toast } from "sonner"
import { MessageSquare, Megaphone, Mail, Pencil, Plus, Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import { NOTIFICATION_TEMPLATES, ANNOUNCEMENTS } from "./mock-data"

const TEMPLATE_COLUMNS: Column[] = [
  { key: "name", header: "Template" },
  { key: "channels", header: "Channels" },
  { key: "updated", header: "Updated" },
  { key: "enabled", header: "Enabled" },
  { key: "actions", header: "" },
]

const ANNOUNCEMENT_COLUMNS: Column[] = [
  { key: "title", header: "Title" },
  { key: "audience", header: "Audience" },
  { key: "priority", header: "Priority" },
  { key: "start", header: "Start" },
  { key: "end", header: "End" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

const CHANNEL_TONE: Record<string, string> = {
  Email: "info",
  Portal: "success",
  SMS: "neutral",
  WhatsApp: "warning",
}

export function CommunicationSection() {
  const [tab, setTab] = useState("templates")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor Communication"
        description="Manage notification templates and publish announcements to vendors across email, portal, WhatsApp and SMS channels."
        icon={MessageSquare}
        actions={
          tab === "announcements" ? (
            <Button size="sm" onClick={() => toast.success("Announcement composer opened")}>
              <Plus className="size-4" /> New Announcement
            </Button>
          ) : (
            <Button size="sm" onClick={() => toast.success("Template composer opened")}>
              <Plus className="size-4" /> New Template
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="templates">
            <Mail className="size-4" /> Templates
          </TabsTrigger>
          <TabsTrigger value="announcements">
            <Megaphone className="size-4" /> Announcements
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <AdminTable
            columns={TEMPLATE_COLUMNS}
            rows={NOTIFICATION_TEMPLATES}
            empty={<EmptyState icon={Bell} title="No templates" />}
            render={(t, key) => {
              switch (key) {
                case "name":
                  return <span className="font-medium">{t.name}</span>
                case "channels":
                  return (
                    <div className="flex flex-wrap gap-1">
                      {t.channels.map((c) => (
                        <StatusBadge key={c} tone={(CHANNEL_TONE[c] as any) ?? "neutral"} label={c} />
                      ))}
                    </div>
                  )
                case "updated":
                  return <span className="text-muted-foreground">{t.updated}</span>
                case "enabled":
                  return <Switch defaultChecked={t.enabled} onCheckedChange={() => toast.success("Template updated")} />
                case "actions":
                  return (
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Editing template")}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        <TabsContent value="announcements">
          <AdminTable
            columns={ANNOUNCEMENT_COLUMNS}
            rows={ANNOUNCEMENTS}
            empty={<EmptyState icon={Megaphone} title="No announcements" />}
            render={(a, key) => {
              switch (key) {
                case "title":
                  return <span className="font-medium">{a.title}</span>
                case "audience":
                  return <span className="text-muted-foreground">{a.audience}</span>
                case "priority":
                  return (
                    <StatusBadge
                      tone={a.priority === "high" ? "danger" : a.priority === "normal" ? "info" : "neutral"}
                      label={a.priority}
                    />
                  )
                case "start":
                  return <span className="text-muted-foreground">{a.start}</span>
                case "end":
                  return <span className="text-muted-foreground">{a.end}</span>
                case "status":
                  return (
                    <StatusBadge
                      tone={
                        a.status === "published"
                          ? "success"
                          : a.status === "scheduled"
                            ? "info"
                            : a.status === "expired"
                              ? "neutral"
                              : "warning"
                      }
                      label={a.status}
                    />
                  )
                case "actions":
                  return (
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Editing announcement")}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
