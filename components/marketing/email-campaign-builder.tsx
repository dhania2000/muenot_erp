"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Loader2, Users, UserX, Send, TestTube2, CalendarClock, Save } from "lucide-react"

const CAMPAIGN_TYPES = ["Newsletter", "Promotional", "Announcement", "Transactional", "Re-engagement"] as const

type Lookups = {
  segments: { id: number; name: string; member_count: number }[]
  tags: { tag: string; count: number }[]
  templates: { id: number; name: string; subject: string; body: string }[]
  users: { id: number; name: string; email: string }[]
  mailboxConnected: boolean
}

type AudienceMode = "all" | "segments" | "tags" | "contacts"

const numArr = (v: any): number[] => (Array.isArray(v) ? v.map(Number) : typeof v === "string" && v ? JSON.parse(v) : [])
const strArr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? JSON.parse(v) : [])

export function EmailCampaignBuilder({
  campaignId,
  open,
  onOpenChange,
  onSaved,
}: {
  campaignId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { data, mutate, isLoading } = useSWR<{ campaign: any }>(
    open && campaignId ? `/api/marketing/campaigns/${campaignId}` : null,
    fetcher,
  )
  const { data: lookups } = useSWR<Lookups>(open ? "/api/marketing/campaigns/lookups" : null, fetcher)

  const c = data?.campaign
  const readOnly = c && !["Draft", "Scheduled", "Paused"].includes(c.status)

  // Local form state
  const [form, setForm] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [testEmail, setTestEmail] = useState("")
  const [scheduleAt, setScheduleAt] = useState("")

  useEffect(() => {
    if (c) {
      setForm({
        name: c.name || "",
        description: c.description || "",
        type: c.type || "Newsletter",
        subject: c.subject || "",
        preheader: c.preheader || "",
        from_name: c.from_name || "",
        reply_to: c.reply_to || "",
        body_html: c.body_html || "",
        sender_user_id: c.sender_user_id ? String(c.sender_user_id) : "shared",
        audience_mode: (c.audience_mode || "segments") as AudienceMode,
        audience_segments: numArr(c.audience_segments),
        audience_tags: strArr(c.audience_tags),
        exclude_unsubscribed: c.exclude_unsubscribed !== 0,
        track_opens: c.track_opens !== 0,
        track_clicks: c.track_clicks !== 0,
        row_version: c.row_version,
      })
    }
  }, [c])

  const set = (patch: Record<string, any>) => setForm((f: any) => ({ ...f, ...patch }))

  // Live audience preview (debounced on audience changes)
  const [preview, setPreview] = useState<any>(null)
  const [previewing, setPreviewing] = useState(false)
  useEffect(() => {
    if (!open || !campaignId || !form) return
    const handle = setTimeout(async () => {
      setPreviewing(true)
      try {
        const res = await fetch(`/api/marketing/campaigns/${campaignId}/audience`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: form.audience_mode,
            segmentIds: form.audience_segments,
            tags: form.audience_tags,
            excludeUnsubscribed: form.exclude_unsubscribed,
          }),
        })
        if (res.ok) setPreview(await res.json())
      } finally {
        setPreviewing(false)
      }
    }, 400)
    return () => clearTimeout(handle)
  }, [open, campaignId, form?.audience_mode, JSON.stringify(form?.audience_segments), JSON.stringify(form?.audience_tags), form?.exclude_unsubscribed])

  async function save(silent = false): Promise<boolean> {
    if (!campaignId || !form) return false
    setSaving(true)
    try {
      const res = await fetch(`/api/marketing/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          type: form.type,
          subject: form.subject,
          preheader: form.preheader,
          from_name: form.from_name,
          reply_to: form.reply_to,
          body_html: form.body_html,
          sender_user_id: form.sender_user_id === "shared" ? null : Number(form.sender_user_id),
          audience_mode: form.audience_mode,
          audience_segments: form.audience_segments,
          audience_tags: form.audience_tags,
          exclude_unsubscribed: form.exclude_unsubscribed,
          track_opens: form.track_opens,
          track_clicks: form.track_clicks,
          row_version: form.row_version,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not save")
      await mutate()
      set({ row_version: body.campaign?.row_version })
      if (!silent) toast.success("Campaign saved")
      onSaved()
      return true
    } catch (err: any) {
      toast.error(err.message || "Could not save")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function transition(action: string, extra: Record<string, any> = {}) {
    if (!campaignId) return
    // Persist edits first so we send exactly what's on screen.
    const ok = await save(true)
    if (!ok) return
    const res = await fetch(`/api/marketing/campaigns/${campaignId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Action failed")
      return
    }
    if (action === "send_now") toast.success(`Sending started to ${body.eligible} recipient(s)`)
    if (action === "schedule") toast.success("Campaign scheduled")
    await mutate()
    onSaved()
    onOpenChange(false)
  }

  async function sendTest() {
    if (!campaignId) return
    const ok = await save(true)
    if (!ok) return
    const res = await fetch(`/api/marketing/campaigns/${campaignId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(body.error || "Could not send test")
    else toast.success(`Test sent${testEmail ? ` to ${testEmail}` : ""}`)
  }

  function applyTemplate(id: string) {
    const tpl = lookups?.templates.find((t) => String(t.id) === id)
    if (tpl) set({ subject: tpl.subject || form.subject, body_html: tpl.body || form.body_html })
  }

  function toggleSegment(id: number) {
    const cur: number[] = form.audience_segments
    set({ audience_segments: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }
  function toggleTag(tag: string) {
    const cur: string[] = form.audience_tags
    set({ audience_tags: cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag] })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <SheetTitle>{c?.name || "Campaign"}</SheetTitle>
            {c?.status ? <Badge variant="secondary">{c.status}</Badge> : null}
          </div>
          <SheetDescription>
            {c?.campaign_code}
            {readOnly ? " — sent campaigns are read-only" : ""}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !form ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <Tabs defaultValue="content" className="w-full">
                <div className="sticky top-0 z-10 border-b bg-background px-6 pt-4">
                  <TabsList>
                    <TabsTrigger value="content">Content</TabsTrigger>
                    <TabsTrigger value="audience">Audience</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                    <TabsTrigger value="send">Review &amp; Send</TabsTrigger>
                  </TabsList>
                </div>

                {/* CONTENT */}
                <TabsContent value="content" className="space-y-4 px-6 py-4">
                  <div className="grid gap-2">
                    <Label>Campaign name</Label>
                    <Input value={form.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Type</Label>
                      <Select value={form.type} disabled={readOnly} onValueChange={(v) => set({ type: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CAMPAIGN_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Start from template</Label>
                      <Select disabled={readOnly} onValueChange={applyTemplate}>
                        <SelectTrigger><SelectValue placeholder="Choose a template" /></SelectTrigger>
                        <SelectContent>
                          {(lookups?.templates || []).map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Subject line</Label>
                    <Input value={form.subject} disabled={readOnly} placeholder="Your subject — use {{first_name}} to personalize"
                      onChange={(e) => set({ subject: e.target.value })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Preheader <span className="text-muted-foreground">(preview text)</span></Label>
                    <Input value={form.preheader} disabled={readOnly} onChange={(e) => set({ preheader: e.target.value })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Email body (HTML)</Label>
                    <Textarea value={form.body_html} disabled={readOnly} rows={12} className="font-mono text-xs"
                      placeholder="<p>Hi {{first_name}},</p>" onChange={(e) => set({ body_html: e.target.value })} />
                    <p className="text-xs text-muted-foreground">
                      Merge tags: {"{{first_name}}"}, {"{{full_name}}"}, {"{{company}}"}, {"{{email}}"}. An unsubscribe link is added automatically.
                    </p>
                  </div>
                </TabsContent>

                {/* AUDIENCE */}
                <TabsContent value="audience" className="space-y-4 px-6 py-4">
                  <div className="grid gap-2">
                    <Label>Who should receive this?</Label>
                    <Select value={form.audience_mode} disabled={readOnly} onValueChange={(v) => set({ audience_mode: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All contacts</SelectItem>
                        <SelectItem value="segments">Specific segments</SelectItem>
                        <SelectItem value="tags">Contacts with tags</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {form.audience_mode === "segments" && (
                    <div className="grid gap-2">
                      <Label>Segments</Label>
                      <div className="flex flex-wrap gap-2">
                        {(lookups?.segments || []).map((s) => (
                          <button key={s.id} type="button" disabled={readOnly} onClick={() => toggleSegment(s.id)}
                            className={`rounded-full border px-3 py-1 text-xs transition ${form.audience_segments.includes(s.id) ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}>
                            {s.name} <span className="opacity-70">({s.member_count})</span>
                          </button>
                        ))}
                        {(lookups?.segments || []).length === 0 && <p className="text-sm text-muted-foreground">No segments yet. Create one in Contacts.</p>}
                      </div>
                    </div>
                  )}

                  {form.audience_mode === "tags" && (
                    <div className="grid gap-2">
                      <Label>Tags</Label>
                      <div className="flex flex-wrap gap-2">
                        {(lookups?.tags || []).map((t) => (
                          <button key={t.tag} type="button" disabled={readOnly} onClick={() => toggleTag(t.tag)}
                            className={`rounded-full border px-3 py-1 text-xs transition ${form.audience_tags.includes(t.tag) ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}>
                            {t.tag} <span className="opacity-70">({t.count})</span>
                          </button>
                        ))}
                        {(lookups?.tags || []).length === 0 && <p className="text-sm text-muted-foreground">No tags yet.</p>}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Checkbox id="excl" checked={form.exclude_unsubscribed} disabled={readOnly}
                      onCheckedChange={(v) => set({ exclude_unsubscribed: Boolean(v) })} />
                    <Label htmlFor="excl" className="font-normal">Exclude unsubscribed &amp; bounced contacts (recommended)</Label>
                  </div>

                  <Separator />

                  <div className="rounded-lg border bg-muted/30 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Estimated audience</span>
                      {previewing ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                    </div>
                    <div className="mt-3 flex gap-6">
                      <div className="flex items-center gap-2">
                        <Users className="size-4 text-emerald-600" />
                        <div>
                          <div className="text-xl font-semibold">{preview?.eligible ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">will receive</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <UserX className="size-4 text-amber-600" />
                        <div>
                          <div className="text-xl font-semibold">{preview?.excluded ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">excluded</div>
                        </div>
                      </div>
                    </div>
                    {preview?.reasons && Object.keys(preview.reasons).length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {Object.entries(preview.reasons).map(([reason, n]) => (
                          <Badge key={reason} variant="outline" className="text-xs font-normal">{reason}: {n as number}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* SETTINGS */}
                <TabsContent value="settings" className="space-y-4 px-6 py-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>From name</Label>
                      <Input value={form.from_name} disabled={readOnly} placeholder="Muenot Technologies"
                        onChange={(e) => set({ from_name: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                      <Label>Reply-to</Label>
                      <Input value={form.reply_to} disabled={readOnly} placeholder="hello@company.com"
                        onChange={(e) => set({ reply_to: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Send from mailbox</Label>
                    <Select value={form.sender_user_id} disabled={readOnly} onValueChange={(v) => set({ sender_user_id: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="shared">Shared business mailbox</SelectItem>
                        {(lookups?.users || []).map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name} ({u.email})</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {lookups && !lookups.mailboxConnected && form.sender_user_id !== "shared" && (
                      <p className="text-xs text-amber-600">This user may not have a mailbox connected — it will fall back to the shared transport.</p>
                    )}
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Checkbox id="to" checked={form.track_opens} disabled={readOnly} onCheckedChange={(v) => set({ track_opens: Boolean(v) })} />
                      <Label htmlFor="to" className="font-normal">Track opens</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="tc" checked={form.track_clicks} disabled={readOnly} onCheckedChange={(v) => set({ track_clicks: Boolean(v) })} />
                      <Label htmlFor="tc" className="font-normal">Track link clicks</Label>
                    </div>
                  </div>
                </TabsContent>

                {/* SEND */}
                <TabsContent value="send" className="space-y-5 px-6 py-4">
                  <div className="rounded-lg border p-4">
                    <h4 className="mb-2 text-sm font-medium">Pre-flight</h4>
                    <ul className="space-y-1.5 text-sm">
                      <Check ok={!!form.subject.trim()}>Subject line set</Check>
                      <Check ok={!!form.body_html.trim()}>Email body added</Check>
                      <Check ok={(preview?.eligible ?? 0) > 0}>{preview?.eligible ?? 0} eligible recipient(s)</Check>
                    </ul>
                  </div>

                  <div className="grid gap-2">
                    <Label>Send a test</Label>
                    <div className="flex gap-2">
                      <Input value={testEmail} placeholder="you@company.com" onChange={(e) => setTestEmail(e.target.value)} />
                      <Button type="button" variant="outline" onClick={sendTest}><TestTube2 className="mr-2 size-4" />Test</Button>
                    </div>
                  </div>

                  <Separator />

                  {!readOnly && (
                    <>
                      <div className="grid gap-2">
                        <Label>Schedule for later</Label>
                        <div className="flex gap-2">
                          <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                          <Button type="button" variant="outline" disabled={!scheduleAt}
                            onClick={() => transition("schedule", { scheduledAt: new Date(scheduleAt).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>
                            <CalendarClock className="mr-2 size-4" />Schedule
                          </Button>
                        </div>
                      </div>
                      <Button type="button" className="w-full" size="lg"
                        onClick={() => transition("send_now")}
                        disabled={!form.subject.trim() || !form.body_html.trim() || (preview?.eligible ?? 0) === 0}>
                        <Send className="mr-2 size-4" />Send now to {preview?.eligible ?? 0} recipient(s)
                      </Button>
                    </>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            <SheetFooter className="flex-row items-center justify-between border-t px-6 py-3">
              <span className="text-xs text-muted-foreground">
                {c?.status === "Sending" ? "Sending in progress…" : readOnly ? "Read-only" : "Changes save to draft"}
              </span>
              {!readOnly && (
                <Button type="button" onClick={() => save()} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}Save
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`inline-flex size-4 items-center justify-center rounded-full text-[10px] ${ok ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
        {ok ? "✓" : "•"}
      </span>
      <span className={ok ? "" : "text-muted-foreground"}>{children}</span>
    </li>
  )
}
