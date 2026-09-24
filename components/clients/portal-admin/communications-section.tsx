"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { ANNOUNCEMENTS, NOTIFICATION_TEMPLATES } from "./data"
import { Megaphone, Pencil, Plus } from "lucide-react"

export function CommunicationsSection() {
  const [templates, setTemplates] = useState(NOTIFICATION_TEMPLATES)
  const [annOpen, setAnnOpen] = useState(false)

  function toggleChannel(id: string, channel: "email" | "portal" | "whatsapp" | "sms") {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, [channel]: !t[channel] } : t)))
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Communications"
        description="Manage portal notification templates and broadcast announcements to clients."
      />

      <Tabs defaultValue="notifications">
        <TabsList>
          <TabsTrigger value="notifications">Notification Templates</TabsTrigger>
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
        </TabsList>

        {/* NOTIFICATIONS */}
        <TabsContent value="notifications" className="grid gap-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Choose which channels each portal event is delivered through. Templates support variables like{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{"{{portalName}}"}</code>.
          </p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="text-center">Email</TableHead>
                  <TableHead className="text-center">Portal</TableHead>
                  <TableHead className="text-center">WhatsApp</TableHead>
                  <TableHead className="text-center">SMS</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.event}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{t.subject}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked={t.email} onCheckedChange={() => toggleChannel(t.id, "email")} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={t.portal} onCheckedChange={() => toggleChannel(t.id, "portal")} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={t.whatsapp} onCheckedChange={() => toggleChannel(t.id, "whatsapp")} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={t.sms} onCheckedChange={() => toggleChannel(t.id, "sms")} />
                    </TableCell>
                    <TableCell>
                      <Button size="icon-sm" variant="ghost" aria-label="Edit template" onClick={() => toast.info("Edit template")}>
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => toast.success("Notification settings saved")}>Save settings</Button>
          </div>
        </TabsContent>

        {/* ANNOUNCEMENTS */}
        <TabsContent value="announcements" className="grid gap-3 pt-2">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAnnOpen(true)}>
              <Plus className="size-4" /> New announcement
            </Button>
          </div>
          <div className="grid gap-3">
            {ANNOUNCEMENTS.map((a) => (
              <div key={a.id} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Megaphone className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{a.title}</h3>
                    <StatusBadge label={a.status} tone={portalStatusTone(a.status)} className="capitalize" />
                    {a.priority === "high" ? <Badge variant="destructive" className="text-[10px]">High priority</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{a.message}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {a.audience === "all" ? "All clients" : a.clients.join(", ")} · {a.start}
                    {a.end ? ` – ${a.end}` : ""}
                  </p>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="Edit announcement" onClick={() => toast.info("Edit announcement")}>
                  <Pencil className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={annOpen} onOpenChange={setAnnOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New announcement</DialogTitle>
            <DialogDescription>Broadcast a message to portal users.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              toast.success("Announcement scheduled")
              setAnnOpen(false)
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="an-title">Title</Label>
              <Input id="an-title" placeholder="Scheduled maintenance" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="an-msg">Message</Label>
              <Textarea id="an-msg" rows={3} placeholder="Message shown to clients…" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Audience</Label>
                <Select defaultValue="all">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All clients</SelectItem>
                    <SelectItem value="specific">Specific clients</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Priority</Label>
                <Select defaultValue="normal">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="an-start">Start</Label>
                <Input id="an-start" type="date" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="an-end">End (optional)</Label>
                <Input id="an-end" type="date" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAnnOpen(false)}>Cancel</Button>
              <Button type="submit">Publish</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
