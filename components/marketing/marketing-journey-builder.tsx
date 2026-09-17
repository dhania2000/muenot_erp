"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Plus, Trash2, ArrowUp, ArrowDown, GripVertical } from "lucide-react"
import {
  STEP_META,
  STEP_ORDER,
  TRIGGER_META,
  TRIGGER_ORDER,
  type Lookups,
  type StepType,
  type TriggerType,
} from "@/components/marketing/journeys-constants"

type Step = {
  key: string
  type: StepType
  name: string
  config: any
  enabled: boolean
}

const WAIT_UNITS = ["minutes", "hours", "days", "weeks"]
const CONDITION_TYPES = [
  { value: "has_tag", label: "Has tag" },
  { value: "field_equals", label: "Field equals" },
  { value: "is_eligible", label: "Is contactable" },
  { value: "email_opened", label: "Opened an email" },
]

let keySeq = 0
function nextKey() {
  keySeq += 1
  return `s_${Date.now()}_${keySeq}`
}

function defaultConfig(type: StepType): any {
  switch (type) {
    case "wait":
      return { value: 1, unit: "days" }
    case "email":
      return { templateId: null, subject: "", body: "" }
    case "whatsapp":
      return { templateName: "", languageCode: "en_US", text: "" }
    case "branch":
      return { condition: { type: "has_tag", tag: "" }, onTrue: "next", onFalse: "exit" }
    case "goal":
      return { condition: { type: "is_eligible", channel: "email" }, exitOnGoal: false }
    default:
      return {}
  }
}

export function JourneyBuilder({
  open,
  onOpenChange,
  journeyId,
  lookups,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  journeyId: number | null
  lookups?: Lookups
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [triggerType, setTriggerType] = useState<TriggerType>("manual")
  const [triggerTag, setTriggerTag] = useState("")
  const [triggerSegment, setTriggerSegment] = useState<string>("")
  const [ownerId, setOwnerId] = useState<string>("none")
  const [allowReentry, setAllowReentry] = useState(false)
  const [allowMultiple, setAllowMultiple] = useState(false)
  const [goalType, setGoalType] = useState<string>("none")
  const [steps, setSteps] = useState<Step[]>([])

  useEffect(() => {
    if (!open) return
    if (journeyId == null) {
      // New journey defaults.
      setName("")
      setDescription("")
      setTriggerType("manual")
      setTriggerTag("")
      setTriggerSegment("")
      setOwnerId("none")
      setAllowReentry(false)
      setAllowMultiple(false)
      setGoalType("none")
      setSteps([])
      return
    }
    setLoading(true)
    fetch(`/api/marketing/journeys/${journeyId}`)
      .then((r) => r.json())
      .then((data) => {
        const j = data.journey
        setName(j.name || "")
        setDescription(j.description || "")
        setTriggerType(j.trigger_type || "manual")
        setTriggerTag(j.trigger_config?.tag || "")
        setTriggerSegment(j.trigger_config?.segmentId ? String(j.trigger_config.segmentId) : "")
        setOwnerId(j.owner_id ? String(j.owner_id) : "none")
        setAllowReentry(!!j.allow_reentry)
        setAllowMultiple(!!j.allow_multiple_active)
        setGoalType(j.goal_type || "none")
        setSteps(
          (data.steps || []).map((s: any) => ({
            key: nextKey(),
            type: s.type,
            name: s.name || "",
            config: s.config || defaultConfig(s.type),
            enabled: !!s.enabled,
          })),
        )
      })
      .catch(() => toast.error("Could not load journey"))
      .finally(() => setLoading(false))
  }, [open, journeyId])

  function addStep(type: StepType) {
    setSteps((prev) => [
      ...prev,
      { key: nextKey(), type, name: STEP_META[type].label, config: defaultConfig(type), enabled: true },
    ])
  }

  function updateStep(key: string, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  function updateConfig(key: string, patch: any) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, config: { ...s.config, ...patch } } : s)))
  }

  function removeStep(key: string) {
    setSteps((prev) => prev.filter((s) => s.key !== key))
  }

  function move(key: string, dir: -1 | 1) {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function buildTriggerConfig() {
    if (triggerType === "tag_added") return { tag: triggerTag.trim() }
    if (triggerType === "segment_entered") return triggerSegment ? { segmentId: Number(triggerSegment) } : null
    return null
  }

  async function save(activate = false) {
    if (!name.trim()) {
      toast.error("Give the journey a name")
      return
    }
    if (triggerType === "tag_added" && !triggerTag.trim()) {
      toast.error("Enter the tag that triggers this journey")
      return
    }
    if (triggerType === "segment_entered" && !triggerSegment) {
      toast.error("Choose the segment that triggers this journey")
      return
    }
    setSaving(true)

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      trigger_type: triggerType,
      trigger_config: buildTriggerConfig(),
      owner_id: ownerId === "none" ? null : Number(ownerId),
      allow_reentry: allowReentry,
      allow_multiple_active: allowMultiple,
      goal_type: goalType === "none" ? null : goalType,
      steps: steps.map((s) => ({ type: s.type, name: s.name || null, config: s.config, enabled: s.enabled })),
    }

    try {
      let id = journeyId
      if (id == null) {
        const res = await fetch("/api/marketing/journeys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || "Could not create journey")
        id = body.id
      } else {
        const res = await fetch(`/api/marketing/journeys/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || "Could not save journey")
      }

      if (activate && id != null) {
        const res = await fetch(`/api/marketing/journeys/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status", status: "Active" }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || "Saved, but could not activate")
      }

      toast.success(activate ? "Journey saved & activated" : "Journey saved")
      onSaved()
      onOpenChange(false)
    } catch (e: any) {
      toast.error(e.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const trig = TRIGGER_META[triggerType]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{journeyId == null ? "New Journey" : "Edit Journey"}</SheetTitle>
          <SheetDescription>Configure the trigger, options, and step-by-step flow.</SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex-1 p-6 text-sm text-muted-foreground">Loading journey…</div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            {/* Basics */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="jname">Name</Label>
                <Input
                  id="jname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. New lead welcome sequence"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="jdesc">Description</Label>
                <Textarea
                  id="jdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this journey for?"
                  rows={2}
                />
              </div>
            </div>

            <Separator />

            {/* Trigger */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Trigger</Label>
                <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRIGGER_ORDER.map((t) => (
                      <SelectItem key={t} value={t}>
                        {TRIGGER_META[t].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{trig.description}</p>
              </div>

              {triggerType === "tag_added" && (
                <div className="space-y-1.5">
                  <Label htmlFor="trigtag">Trigger tag</Label>
                  <Input
                    id="trigtag"
                    value={triggerTag}
                    onChange={(e) => setTriggerTag(e.target.value)}
                    placeholder="e.g. vip"
                  />
                </div>
              )}

              {triggerType === "segment_entered" && (
                <div className="space-y-1.5">
                  <Label>Trigger segment</Label>
                  <Select value={triggerSegment} onValueChange={setTriggerSegment}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a segment" />
                    </SelectTrigger>
                    <SelectContent>
                      {(lookups?.segments || []).map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <Separator />

            {/* Options */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Owner</Label>
                <Select value={ownerId} onValueChange={setOwnerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {(lookups?.users || []).map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Goal</Label>
                <Select value={goalType} onValueChange={setGoalType}>
                  <SelectTrigger>
                    <SelectValue placeholder="No explicit goal" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No explicit goal</SelectItem>
                    <SelectItem value="email_opened">Email opened</SelectItem>
                    <SelectItem value="became_customer">Became customer</SelectItem>
                    <SelectItem value="custom">Custom checkpoint</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5">
                  <Label>Allow re-entry</Label>
                  <p className="text-xs text-muted-foreground">Let a contact enroll again after finishing.</p>
                </div>
                <Switch checked={allowReentry} onCheckedChange={setAllowReentry} />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5">
                  <Label>Allow multiple active</Label>
                  <p className="text-xs text-muted-foreground">Permit several concurrent enrollments per contact.</p>
                </div>
                <Switch checked={allowMultiple} onCheckedChange={setAllowMultiple} />
              </div>
            </div>

            <Separator />

            {/* Steps */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Steps</Label>
                  <p className="text-xs text-muted-foreground">{steps.length} step(s) in this flow</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Plus className="size-4" />
                      Add step
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                    <DropdownMenuLabel>Add a step</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {STEP_ORDER.map((t) => {
                      const meta = STEP_META[t]
                      return (
                        <DropdownMenuItem key={t} onClick={() => addStep(t)}>
                          <meta.icon className="size-4" />
                          {meta.label}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {steps.length === 0 && (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No steps yet. Add your first step to build the flow.
                </div>
              )}

              <div className="space-y-3">
                {steps.map((s, i) => {
                  const meta = STEP_META[s.type]
                  return (
                    <div key={s.key} className="rounded-md border">
                      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
                        <GripVertical className="size-4 text-muted-foreground" />
                        <meta.icon className="size-4 text-primary" />
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium">{meta.label}</span>
                        {!s.enabled && (
                          <Badge variant="outline" className="text-[10px]">
                            Disabled
                          </Badge>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={i === 0}
                            onClick={() => move(s.key, -1)}
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={i === steps.length - 1}
                            onClick={() => move(s.key, 1)}
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Switch checked={s.enabled} onCheckedChange={(v) => updateStep(s.key, { enabled: v })} />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive"
                            onClick={() => removeStep(s.key)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-3 p-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Step label</Label>
                          <Input
                            value={s.name}
                            onChange={(e) => updateStep(s.key, { name: e.target.value })}
                            placeholder={meta.label}
                          />
                        </div>
                        <StepConfigEditor step={s} lookups={lookups} onChange={(patch) => updateConfig(s.key, patch)} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>
            Save draft
          </Button>
          <Button onClick={() => save(true)} disabled={saving}>
            Save &amp; activate
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function StepConfigEditor({
  step,
  lookups,
  onChange,
}: {
  step: Step
  lookups?: Lookups
  onChange: (patch: any) => void
}) {
  const c = step.config || {}

  switch (step.type) {
    case "wait":
      return (
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Wait for</Label>
            <Input
              type="number"
              min={0}
              value={c.value ?? 1}
              onChange={(e) => onChange({ value: Number(e.target.value) })}
              className="w-24"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Unit</Label>
            <Select value={c.unit || "days"} onValueChange={(v) => onChange({ unit: v })}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WAIT_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )

    case "email":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Template</Label>
            <Select
              value={c.templateId ? String(c.templateId) : "custom"}
              onValueChange={(v) => onChange({ templateId: v === "custom" ? null : Number(v) })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Custom copy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">Custom copy</SelectItem>
                {(lookups?.templates || []).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!c.templateId && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Subject</Label>
                <Input value={c.subject || ""} onChange={(e) => onChange({ subject: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Body</Label>
                <Textarea
                  value={c.body || ""}
                  onChange={(e) => onChange({ body: e.target.value })}
                  rows={4}
                  placeholder="Use {{full_name}} to personalise."
                />
              </div>
            </>
          )}
        </div>
      )

    case "whatsapp":
      return (
        <div className="space-y-3">
          {!lookups?.whatsappConnected && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              WhatsApp is not connected — this step will be skipped until you connect the WhatsApp integration.
            </p>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Approved template</Label>
            <Select
              value={c.templateName ? c.templateName : "text"}
              onValueChange={(v) => onChange({ templateName: v === "text" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Free text" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Free text message</SelectItem>
                {(lookups?.whatsappTemplates || []).map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name} ({t.language})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {c.templateName ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Language code</Label>
              <Input
                value={c.languageCode || "en_US"}
                onChange={(e) => onChange({ languageCode: e.target.value })}
                className="w-40"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea
                value={c.text || ""}
                onChange={(e) => onChange({ text: e.target.value })}
                rows={3}
                placeholder="Use {{full_name}} to personalise."
              />
            </div>
          )}
        </div>
      )

    case "add_tag":
    case "remove_tag":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">Tag</Label>
          <Input value={c.tag || ""} onChange={(e) => onChange({ tag: e.target.value })} placeholder="e.g. nurtured" />
        </div>
      )

    case "add_segment":
    case "remove_segment":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">Segment</Label>
          <Select
            value={c.segmentId ? String(c.segmentId) : ""}
            onValueChange={(v) => onChange({ segmentId: Number(v) })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a segment" />
            </SelectTrigger>
            <SelectContent>
              {(lookups?.segments || []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )

    case "assign_owner":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">Assign to</Label>
          <Select value={c.ownerId ? String(c.ownerId) : ""} onValueChange={(v) => onChange({ ownerId: Number(v) })}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a team member" />
            </SelectTrigger>
            <SelectContent>
              {(lookups?.users || []).map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )

    case "notification":
    case "create_task":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Recipient</Label>
            <Select value={c.userId ? String(c.userId) : "owner"} onValueChange={(v) => onChange({ userId: v === "owner" ? null : Number(v) })}>
              <SelectTrigger>
                <SelectValue placeholder="Journey owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Journey owner</SelectItem>
                {(lookups?.users || []).map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input value={c.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Message</Label>
            <Textarea value={c.body || ""} onChange={(e) => onChange({ body: e.target.value })} rows={2} />
          </div>
        </div>
      )

    case "branch":
      return (
        <div className="space-y-3">
          <ConditionEditor
            condition={c.condition}
            lookups={lookups}
            onChange={(condition) => onChange({ condition })}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">If true</Label>
              <Select value={String(c.onTrue ?? "next")} onValueChange={(v) => onChange({ onTrue: v === "next" || v === "exit" ? v : Number(v) })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="next">Continue</SelectItem>
                  <SelectItem value="exit">Exit journey</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">If false</Label>
              <Select value={String(c.onFalse ?? "exit")} onValueChange={(v) => onChange({ onFalse: v === "next" || v === "exit" ? v : Number(v) })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="next">Continue</SelectItem>
                  <SelectItem value="exit">Exit journey</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )

    case "goal":
      return (
        <div className="space-y-3">
          <ConditionEditor
            condition={c.condition}
            lookups={lookups}
            onChange={(condition) => onChange({ condition })}
          />
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="text-xs">Exit on goal</Label>
              <p className="text-xs text-muted-foreground">Complete the journey once the goal is reached.</p>
            </div>
            <Switch checked={!!c.exitOnGoal} onCheckedChange={(v) => onChange({ exitOnGoal: v })} />
          </div>
        </div>
      )

    case "end":
      return <p className="text-xs text-muted-foreground">Completes the journey for the contact.</p>

    default:
      return null
  }
}

function ConditionEditor({
  condition,
  lookups,
  onChange,
}: {
  condition: any
  lookups?: Lookups
  onChange: (c: any) => void
}) {
  const cond = condition || { type: "has_tag" }
  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Condition</Label>
        <Select value={cond.type} onValueChange={(v) => onChange({ type: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {cond.type === "has_tag" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Tag</Label>
          <Input value={cond.tag || ""} onChange={(e) => onChange({ ...cond, tag: e.target.value })} />
        </div>
      )}

      {cond.type === "field_equals" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Field</Label>
            <Input
              value={cond.field || ""}
              onChange={(e) => onChange({ ...cond, field: e.target.value })}
              placeholder="e.g. lifecycle_stage"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Equals</Label>
            <Input value={cond.value || ""} onChange={(e) => onChange({ ...cond, value: e.target.value })} />
          </div>
        </div>
      )}

      {cond.type === "is_eligible" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Channel</Label>
          <Select value={cond.channel || "email"} onValueChange={(v) => onChange({ ...cond, channel: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="whatsapp">WhatsApp</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {cond.type === "email_opened" && (
        <p className="text-xs text-muted-foreground">True if the contact opened an email since enrolling.</p>
      )}
    </div>
  )
}
