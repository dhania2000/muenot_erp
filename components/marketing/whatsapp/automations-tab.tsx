"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Plus, Loader2, Trash2, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_ACTION_LABEL,
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_LABEL,
  type AutomationAction,
  type AutomationTrigger,
} from "@/lib/whatsapp-config"
import { NativeSelect, TabState } from "./shared"
import type { Automation, WhatsAppCaps } from "./types"

/** Rule-based automation manager (chatbot-ready trigger → action rules). */
export function AutomationsTab({ caps }: { caps: WhatsAppCaps | null }) {
  const { data, isLoading, mutate } = useSWR<{ automations: Automation[] }>(
    "/api/marketing/whatsapp/automations",
    fetcher,
  )
  const automations = data?.automations ?? []
  const canManage = caps?.canManageAutomation ?? false

  async function patch(id: number, body: Record<string, unknown>) {
    const res = await fetch(`/api/marketing/whatsapp/automations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      toast.error(json.error || "Failed to update")
      return
    }
    mutate()
  }

  async function remove(id: number) {
    const res = await fetch(`/api/marketing/whatsapp/automations/${id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Failed to delete")
      return
    }
    toast.success("Automation deleted")
    mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          When a trigger fires, run an action automatically — welcome messages, keyword routing, human handoff and more.
        </p>
        {canManage ? <AutomationDialog onSaved={() => mutate()} /> : null}
      </div>

      {isLoading ? (
        <TabState loading>Loading automations…</TabState>
      ) : automations.length === 0 ? (
        <TabState>No automation rules yet.</TabState>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((a) => (
            <Card key={a.id}>
              <CardHeader className="gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Workflow className="size-4 text-muted-foreground" />
                    {a.name}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={a.isActive ? "secondary" : "outline"}>{a.isActive ? "Active" : "Paused"}</Badge>
                    {canManage ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => patch(a.id, { isActive: !a.isActive })}>
                          {a.isActive ? "Pause" : "Activate"}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove(a.id)} aria-label="Delete automation">
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  WHEN: {AUTOMATION_TRIGGER_LABEL[a.triggerType as AutomationTrigger] ?? a.triggerType}
                </Badge>
                <span aria-hidden>→</span>
                <Badge variant="outline" className="text-[10px]">
                  DO: {AUTOMATION_ACTION_LABEL[a.actionType as AutomationAction] ?? a.actionType}
                </Badge>
                {a.departmentName ? <Badge variant="outline" className="text-[10px]">{a.departmentName}</Badge> : null}
                <span className="ml-auto text-xs">Ran {a.runCount}×</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function AutomationDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [name, setName] = React.useState("")
  const [trigger, setTrigger] = React.useState<AutomationTrigger>("welcome")
  const [action, setAction] = React.useState<AutomationAction>("send_template")
  const [keywords, setKeywords] = React.useState("")
  const [hours, setHours] = React.useState("2")
  const [templateName, setTemplateName] = React.useState("hello_world")
  const [languageCode, setLanguageCode] = React.useState("en_US")
  const [text, setText] = React.useState("")

  async function save() {
    if (!name.trim()) {
      toast.error("Give the automation a name.")
      return
    }
    const triggerConfig: Record<string, unknown> = {}
    if (trigger === "keyword") triggerConfig.keywords = keywords
    if (trigger === "no_reply") triggerConfig.hours = Number(hours) || 2
    const actionConfig: Record<string, unknown> = {}
    if (action === "send_template") {
      actionConfig.templateName = templateName
      actionConfig.languageCode = languageCode
    }
    if (action === "send_text") actionConfig.text = text

    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, triggerType: trigger, triggerConfig, actionType: action, actionConfig }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to create automation")
      toast.success("Automation created")
      setOpen(false)
      setName("")
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" /> New automation</Button>} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create an automation</DialogTitle>
          <DialogDescription>Pick a trigger and the action to run when it matches.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="a-name" className="text-xs text-muted-foreground">Name</Label>
            <Input id="a-name" placeholder="e.g. Welcome new leads" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Trigger</Label>
              <NativeSelect value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
                {AUTOMATION_TRIGGERS.map((t) => (
                  <option key={t} value={t}>{AUTOMATION_TRIGGER_LABEL[t]}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Action</Label>
              <NativeSelect value={action} onChange={(e) => setAction(e.target.value as AutomationAction)}>
                {AUTOMATION_ACTIONS.map((t) => (
                  <option key={t} value={t}>{AUTOMATION_ACTION_LABEL[t]}</option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {trigger === "keyword" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="a-kw" className="text-xs text-muted-foreground">Keywords (comma separated)</Label>
              <Input id="a-kw" placeholder="price, quotation, demo" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </div>
          ) : null}
          {trigger === "no_reply" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="a-hrs" className="text-xs text-muted-foreground">Hours without a reply</Label>
              <Input id="a-hrs" type="number" min={1} value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
          ) : null}

          {action === "send_template" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="a-tpl" className="text-xs text-muted-foreground">Template name</Label>
                <Input id="a-tpl" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="a-lang" className="text-xs text-muted-foreground">Language</Label>
                <Input id="a-lang" value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} />
              </div>
            </div>
          ) : null}
          {action === "send_text" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="a-text" className="text-xs text-muted-foreground">Reply text (in-window only)</Label>
              <Textarea id="a-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
