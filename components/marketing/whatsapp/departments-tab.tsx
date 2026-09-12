"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Plus, Loader2, Building2, Users, Inbox } from "lucide-react"

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
import { ROUTING_METHOD_LABEL } from "@/lib/whatsapp-config"
import { TabState } from "./shared"
import type { Department, WhatsAppCaps } from "./types"

/** Department directory + create/edit (routing + auto-assign). Admin-managed. */
export function DepartmentsTab({ caps }: { caps: WhatsAppCaps | null }) {
  const { data, isLoading, mutate } = useSWR<{ departments: Department[] }>(
    "/api/marketing/whatsapp/departments",
    fetcher,
  )
  const departments = data?.departments ?? []
  const canManage = caps?.canManagePlatform ?? false

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Route customer chats to the right team. Keyword and round-robin routing keep the shared number organised.
        </p>
        {canManage ? <DepartmentDialog onSaved={() => mutate()} /> : null}
      </div>

      {isLoading ? (
        <TabState loading>Loading departments…</TabState>
      ) : departments.length === 0 ? (
        <TabState>No departments yet.</TabState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {departments.map((d) => (
            <Card key={d.id}>
              <CardHeader className="gap-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span
                      className="flex size-7 items-center justify-center rounded-md text-white"
                      style={{ backgroundColor: d.color || "#25D366" }}
                    >
                      <Building2 className="size-4" />
                    </span>
                    {d.name}
                  </CardTitle>
                  <Badge variant={d.isActive ? "secondary" : "outline"}>{d.isActive ? "Active" : "Inactive"}</Badge>
                </div>
                {d.description ? <p className="text-xs text-muted-foreground text-pretty">{d.description}</p> : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1"><Users className="size-4" /> {d.agentCount}</span>
                  <span className="flex items-center gap-1"><Inbox className="size-4" /> {d.openConversations} open</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {ROUTING_METHOD_LABEL[d.routingMethod as keyof typeof ROUTING_METHOD_LABEL] ?? d.routingMethod}
                  </Badge>
                  {d.autoAssign ? <Badge variant="outline" className="text-[10px]">Auto-assign</Badge> : null}
                </div>
                {d.keywords.length ? (
                  <div className="flex flex-wrap gap-1">
                    {d.keywords.slice(0, 6).map((k) => (
                      <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{k}</span>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function DepartmentDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({ name: "", description: "", color: "#25D366", autoAssign: true })

  async function save() {
    if (!form.name.trim()) {
      toast.error("Department name is required.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to create department")
      toast.success("Department created")
      setForm({ name: "", description: "", color: "#25D366", autoAssign: true })
      setOpen(false)
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" /> New department</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a department</DialogTitle>
          <DialogDescription>Agents and routing rules can be configured after it&apos;s created.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="d-name" className="text-xs text-muted-foreground">Name</Label>
            <Input id="d-name" placeholder="e.g. Enterprise Sales" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="d-desc" className="text-xs text-muted-foreground">Description</Label>
            <Textarea id="d-desc" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="d-color" className="text-xs text-muted-foreground">Colour</Label>
              <input
                id="d-color"
                type="color"
                value={form.color}
                onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                className="h-9 w-16 cursor-pointer rounded-md border border-input bg-background"
              />
            </div>
            <label className="mt-5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.autoAssign}
                onChange={(e) => setForm((f) => ({ ...f, autoAssign: e.target.checked }))}
                className="size-4 rounded border-input"
              />
              Auto-assign incoming chats
            </label>
          </div>
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
