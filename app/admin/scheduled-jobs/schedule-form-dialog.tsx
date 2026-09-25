"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { JobMetadata, ScheduledJob } from "./types"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  metadata: JobMetadata
  job: ScheduledJob | null
  onSaved: () => void
}

// A small, dependency-free list covering common IANA zones plus the browser's.
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
]

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

type FormState = {
  name: string
  actionKey: string
  presetKey: string
  cronExpression: string
  timezone: string
  startAt: string
  endAt: string
  enabled: boolean
  maxAttempts: number
  notifyOnFailure: boolean
  notifyOnSuccess: boolean
  notifyEmails: string
  reminderTitle: string
  reminderBody: string
  datasetKey: string
  format: string
  reportScheduleId: string
}

function initialState(job: ScheduledJob | null, metadata: JobMetadata): FormState {
  const params = (job?.actionParams ?? {}) as Record<string, unknown>
  return {
    name: job?.name ?? "",
    actionKey: job?.actionKey ?? metadata.actions[0]?.key ?? "notification.reminder",
    presetKey: job?.presetKey ?? metadata.presets[0]?.key ?? "daily_0900",
    cronExpression: job?.cronExpression ?? metadata.presets[0]?.expression ?? "0 9 * * *",
    timezone: job?.timezone ?? browserZone(),
    startAt: "",
    endAt: "",
    enabled: job?.enabled ?? true,
    maxAttempts: job?.maxAttempts ?? 3,
    notifyOnFailure: job?.notifyOnFailure ?? true,
    notifyOnSuccess: job?.notifyOnSuccess ?? false,
    notifyEmails: (job?.notifyEmails ?? []).join(", "),
    reminderTitle: typeof params.title === "string" ? params.title : "",
    reminderBody: typeof params.body === "string" ? params.body : "",
    datasetKey: typeof params.datasetKey === "string" ? params.datasetKey : metadata.datasets[0]?.key ?? "",
    format: typeof params.format === "string" ? params.format : metadata.formats[0]?.value ?? "csv",
    reportScheduleId: params.reportScheduleId != null ? String(params.reportScheduleId) : "",
  }
}

export function ScheduleFormDialog({ open, onOpenChange, metadata, job, onSaved }: Props) {
  const [state, setState] = useState<FormState>(() => initialState(job, metadata))
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<string[]>([])
  const [previewError, setPreviewError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      setState(initialState(job, metadata))
      setFieldErrors({})
      setPreview([])
      setPreviewError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }))

  const buildPayload = () => {
    const emails = state.notifyEmails
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
    let actionParams: Record<string, unknown> = {}
    if (state.actionKey === "notification.reminder") {
      actionParams = { title: state.reminderTitle, body: state.reminderBody }
    } else if (state.actionKey === "data_export.run") {
      actionParams = { datasetKey: state.datasetKey, format: state.format }
    } else if (state.actionKey === "report_schedule.deliver") {
      actionParams = { reportScheduleId: Number(state.reportScheduleId) }
    }
    return {
      name: state.name,
      actionKey: state.actionKey,
      actionParams,
      presetKey: state.presetKey,
      cronExpression: state.cronExpression,
      timezone: state.timezone,
      startAt: state.startAt || null,
      endAt: state.endAt || null,
      enabled: state.enabled,
      maxAttempts: state.maxAttempts,
      notifyOnFailure: state.notifyOnFailure,
      notifyOnSuccess: state.notifyOnSuccess,
      notifyEmails: emails,
    }
  }

  // Live next-run preview (server validates + honours timezone/DST + window).
  useEffect(() => {
    if (!open) return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/scheduled-jobs/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload()),
        })
        const body = await res.json()
        if (body.ok) {
          setPreview(body.nextRuns ?? [])
          setPreviewError(null)
        } else {
          setPreview([])
          setPreviewError("Fix the highlighted fields to preview run times.")
          if (body.fieldErrors) setFieldErrors(body.fieldErrors)
        }
      } catch {
        setPreview([])
      }
    }, 400)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.cronExpression, state.timezone, state.startAt, state.endAt, state.presetKey])

  const timezones = useMemo(() => {
    const bz = browserZone()
    return Array.from(new Set([bz, ...COMMON_TIMEZONES]))
  }, [])

  async function submit() {
    setSaving(true)
    setFieldErrors({})
    try {
      const url = job ? `/api/admin/scheduled-jobs/${job.id}` : "/api/admin/scheduled-jobs"
      const payload: Record<string, unknown> = buildPayload()
      if (job) payload.version = job.version
      const res = await fetch(url, {
        method: job ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(job ? {} : { "Idempotency-Key": crypto.randomUUID() }),
        },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) {
        if (body.fieldErrors) setFieldErrors(body.fieldErrors)
        throw new Error(body.error ?? "Failed to save schedule.")
      }
      toast.success(job ? "Schedule updated." : "Schedule created.")
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save schedule.")
    } finally {
      setSaving(false)
    }
  }

  const err = (key: string) => fieldErrors[key]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{job ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            Choose a reviewed action and when it should run. Times use the selected timezone; the preview
            reflects daylight-saving transitions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-name">Name</Label>
            <Input id="job-name" value={state.name} onChange={(e) => set("name", e.target.value)} placeholder="Daily reminder" />
            {err("name") && <p className="text-xs text-destructive">{err("name")}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Action</Label>
            <Select value={state.actionKey} onValueChange={(v) => set("actionKey", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {metadata.actions.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {metadata.actions.find((a) => a.key === state.actionKey)?.description}
            </p>
          </div>

          {state.actionKey === "notification.reminder" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-title">Reminder title</Label>
                <Input id="reminder-title" value={state.reminderTitle} onChange={(e) => set("reminderTitle", e.target.value)} />
                {err("actionParams.title") && <p className="text-xs text-destructive">{err("actionParams.title")}</p>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-body">Message</Label>
                <Input id="reminder-body" value={state.reminderBody} onChange={(e) => set("reminderBody", e.target.value)} />
                {err("actionParams.body") && <p className="text-xs text-destructive">{err("actionParams.body")}</p>}
              </div>
            </div>
          )}

          {state.actionKey === "data_export.run" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Dataset</Label>
                <Select value={state.datasetKey} onValueChange={(v) => set("datasetKey", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select dataset" />
                  </SelectTrigger>
                  <SelectContent>
                    {metadata.datasets.map((d) => (
                      <SelectItem key={d.key} value={d.key}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {err("actionParams.datasetKey") && <p className="text-xs text-destructive">{err("actionParams.datasetKey")}</p>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Format</Label>
                <Select value={state.format} onValueChange={(v) => set("format", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {metadata.formats.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {state.actionKey === "report_schedule.deliver" && (
            <div className="flex flex-col gap-1.5">
              <Label>Report schedule</Label>
              <Select value={state.reportScheduleId} onValueChange={(v) => set("reportScheduleId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a saved report schedule" />
                </SelectTrigger>
                <SelectContent>
                  {metadata.reportSchedules.length === 0 ? (
                    <SelectItem value="none" disabled>
                      No saved report schedules
                    </SelectItem>
                  ) : (
                    metadata.reportSchedules.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {err("actionParams.reportScheduleId") && (
                <p className="text-xs text-destructive">{err("actionParams.reportScheduleId")}</p>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Preset</Label>
              <Select
                value={state.presetKey}
                onValueChange={(v) => {
                  set("presetKey", v)
                  const preset = metadata.presets.find((p) => p.key === v)
                  if (preset?.expression) set("cronExpression", preset.expression)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metadata.presets.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Timezone</Label>
              <Select value={state.timezone} onValueChange={(v) => set("timezone", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {err("timezone") && <p className="text-xs text-destructive">{err("timezone")}</p>}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cron">Cron expression</Label>
            <Input
              id="cron"
              value={state.cronExpression}
              onChange={(e) => {
                set("cronExpression", e.target.value)
                set("presetKey", "custom")
              }}
              className="font-mono"
              disabled={state.presetKey !== "custom" && !!metadata.presets.find((p) => p.key === state.presetKey)?.expression}
            />
            <p className="text-xs text-muted-foreground">
              Minimum interval {metadata.limits.minIntervalMinutes} minutes. Select the “Custom” preset to edit directly.
            </p>
            {err("cronExpression") && <p className="text-xs text-destructive">{err("cronExpression")}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start">Start (optional)</Label>
              <Input id="start" type="datetime-local" value={state.startAt} onChange={(e) => set("startAt", e.target.value)} />
              {err("startAt") && <p className="text-xs text-destructive">{err("startAt")}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="end">End (optional)</Label>
              <Input id="end" type="datetime-local" value={state.endAt} onChange={(e) => set("endAt", e.target.value)} />
              {err("endAt") && <p className="text-xs text-destructive">{err("endAt")}</p>}
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3">
            <div className="text-xs font-medium text-muted-foreground">Next runs (in {state.timezone})</div>
            {previewError ? (
              <p className="mt-1 text-xs text-destructive">{previewError}</p>
            ) : preview.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No upcoming runs for this configuration.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5">
                {preview.map((iso) => (
                  <li key={iso} className="text-xs tabular-nums">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: state.timezone,
                    }).format(new Date(iso))}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="max-attempts">Max attempts</Label>
            <Input
              id="max-attempts"
              type="number"
              min={1}
              max={metadata.limits.maxAttempts}
              value={state.maxAttempts}
              onChange={(e) => set("maxAttempts", Math.floor(Number(e.target.value)))}
              className="w-28"
            />
            {err("maxAttempts") && <p className="text-xs text-destructive">{err("maxAttempts")}</p>}
          </div>

          <div className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled" className="cursor-pointer">
                Enabled
              </Label>
              <Switch id="enabled" checked={state.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="notify-failure" className="cursor-pointer">
                Notify on failure
              </Label>
              <Switch id="notify-failure" checked={state.notifyOnFailure} onCheckedChange={(v) => set("notifyOnFailure", v)} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="notify-success" className="cursor-pointer">
                Notify on success
              </Label>
              <Switch id="notify-success" checked={state.notifyOnSuccess} onCheckedChange={(v) => set("notifyOnSuccess", v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emails">Notify emails (comma-separated, optional)</Label>
              <Textarea
                id="emails"
                value={state.notifyEmails}
                onChange={(e) => set("notifyEmails", e.target.value)}
                placeholder="ops@example.com, admin@example.com"
                rows={2}
              />
              <p className="text-xs text-muted-foreground">Up to {metadata.limits.maxNotifyEmails} recipients.</p>
              {err("notifyEmails") && <p className="text-xs text-destructive">{err("notifyEmails")}</p>}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {job ? "Save changes" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
