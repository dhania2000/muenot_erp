"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { KpiCheckin, KpiGoalComputed } from "@/lib/goals-kpi/config"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  goal: KpiGoalComputed | null
  canManage: boolean
  onSaved: () => void
}

export function KpiCheckinDialog({ open, onOpenChange, goal, canManage, onSaved }: Props) {
  const [value, setValue] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  const { data, mutate, isLoading } = useSWR<{ checkins: KpiCheckin[] }>(
    open && goal ? `/api/hr/goals-kpi/${goal.id}/checkins` : null,
    fetcher,
  )
  const checkins = data?.checkins ?? []

  async function submit() {
    if (!goal) return
    if (value === "" || !Number.isFinite(Number(value))) {
      toast.error("Enter a numeric actual value.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/goals-kpi/${goal.id}/checkins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actual_value: Number(value), note: note.trim() || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Check-in failed")
      toast.success("Progress recorded")
      setValue("")
      setNote("")
      mutate()
      onSaved()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Progress check-in</DialogTitle>
          <DialogDescription>{goal ? goal.name : ""}</DialogDescription>
        </DialogHeader>

        {goal && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current</span>
            <span className="font-medium tabular-nums">
              {goal.actual_value}
              {goal.unit ? ` ${goal.unit}` : ""} / {goal.target_value}
              {goal.unit ? ` ${goal.unit}` : ""}
            </span>
          </div>
        )}

        {canManage && (
          <div className="grid gap-4 py-1">
            <div className="grid gap-2">
              <Label htmlFor="checkin-value">New actual value</Label>
              <Input
                id="checkin-value"
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Latest measured value"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="checkin-note">Note (optional)</Label>
              <Textarea
                id="checkin-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Context for this update"
              />
            </div>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Record check-in"}
            </Button>
          </div>
        )}

        <Separator />

        <div className="grid gap-2">
          <p className="text-sm font-medium">History</p>
          <ScrollArea className="max-h-56">
            {isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
            ) : checkins.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No check-ins yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 pr-2">
                {checkins.map((c) => (
                  <li key={c.id} className="rounded-lg border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium tabular-nums">
                        {c.actual_value}
                        {goal?.unit ? ` ${goal.unit}` : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleString()}
                      </span>
                    </div>
                    {c.note && <p className="mt-1 text-muted-foreground">{c.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
