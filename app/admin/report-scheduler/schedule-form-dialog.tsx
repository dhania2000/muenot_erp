"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SchedulerMetadata } from "./types"

type Props = {
  reports: { id: number; name: string; sourceKey: string }[]
  metadata: SchedulerMetadata
  onClose: () => void
  onSaved: () => void
}

const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
]

export function ScheduleFormDialog({ reports, metadata, onClose, onSaved }: Props) {
  const [reportId, setReportId] = useState<string>(reports[0] ? String(reports[0].id) : "")
  const [frequency, setFrequency] = useState<string>("daily")
  const [hour, setHour] = useState("6")
  const [minute, setMinute] = useState("0")
  const [weekday, setWeekday] = useState("1")
  const [dayOfMonth, setDayOfMonth] = useState("1")
  const [customCron, setCustomCron] = useState("0 6 * * *")
  const [format, setFormat] = useState<string>(metadata.formats[0]?.value ?? "pdf")
  const [channel, setChannel] = useState<string>(metadata.channels[0]?.value ?? "email")
  const [recipients, setRecipients] = useState("")
  const [timezone, setTimezone] = useState("UTC")
  const [saving, setSaving] = useState(false)

  const isEmail = channel === "email"

  async function submit() {
    if (!reportId) {
      toast.error("Choose a report to schedule.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/reports/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportId: Number(reportId),
          frequency,
          format,
          channel,
          recipients: isEmail ? recipients : "",
          timezone,
          cadence: {
            minute: Number(minute),
            hour: Number(hour),
            weekday: Number(weekday),
            dayOfMonth: Number(dayOfMonth),
          },
          customCron: frequency === "custom" ? customCron : undefined,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed to create schedule")
      toast.success("Schedule created")
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New report schedule</DialogTitle>
          <DialogDescription>
            Pick a saved report, a cadence, and how the finished file should be delivered.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report">Report</Label>
            {reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No saved reports available. Create one in the report builder first.
              </p>
            ) : (
              <Select value={reportId} onValueChange={setReportId}>
                <SelectTrigger id="report">
                  <SelectValue placeholder="Select a report" />
                </SelectTrigger>
                <SelectContent>
                  {reports.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frequency">Frequency</Label>
            <Select value={frequency} onValueChange={setFrequency}>
              <SelectTrigger id="frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {metadata.frequencies.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {frequency === "custom" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cron">Cron expression</Label>
              <Input
                id="cron"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="0 6 * * *"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Five space-separated fields: minute hour day-of-month month day-of-week.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {frequency === "weekly" && (
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="weekday">Day of week</Label>
                  <Select value={weekday} onValueChange={setWeekday}>
                    <SelectTrigger id="weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {frequency === "monthly" && (
                <div className="flex w-28 flex-col gap-1.5">
                  <Label htmlFor="dom">Day of month</Label>
                  <Input
                    id="dom"
                    type="number"
                    min={1}
                    max={31}
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(e.target.value)}
                  />
                </div>
              )}
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="hour">Hour</Label>
                <Input
                  id="hour"
                  type="number"
                  min={0}
                  max={23}
                  value={hour}
                  onChange={(e) => setHour(e.target.value)}
                />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="minute">Minute</Label>
                <Input
                  id="minute"
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <Label htmlFor="format">Format</Label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="format">
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
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <Label htmlFor="channel">Delivery</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger id="channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metadata.channels.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isEmail ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipients">Recipients</Label>
              <Textarea
                id="recipients"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="finance@acme.com, cfo@acme.com"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Comma, semicolon, or newline separated. Up to {metadata.caps.maxRecipients} addresses.
              </p>
            </div>
          ) : (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Each run is retained as a secure download link that expires after{" "}
              {Math.round(metadata.caps.downloadTtlMs / (24 * 60 * 60 * 1000))} days. Fetch it from
              this schedule&apos;s run history.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="UTC"
            />
            <p className="text-xs text-muted-foreground">
              IANA timezone, e.g. UTC, Asia/Kolkata, America/New_York.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || reports.length === 0}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
