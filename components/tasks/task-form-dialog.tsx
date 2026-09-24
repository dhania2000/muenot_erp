"use client"

import { useEffect, useState } from "react"
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
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import type { TaskMeta } from "./task-shared"
import { toDateInput } from "./task-shared"

type TaskFormValue = {
  id?: number
  title: string
  description: string
  task_type: string
  status: string
  priority: string
  assignee_id: string
  team_id: string
  start_date: string
  due_date: string
  recurrence: string
  recurrence_interval: string
  recurrence_until: string
  approval_required: boolean
}

const UNSET = "__none"

function emptyValue(meta?: TaskMeta): TaskFormValue {
  return {
    title: "",
    description: "",
    task_type: meta?.types?.[0] ?? "Task",
    status: meta?.statuses?.[0] ?? "To Do",
    priority: "Medium",
    assignee_id: "",
    team_id: "",
    start_date: "",
    due_date: "",
    recurrence: "none",
    recurrence_interval: "1",
    recurrence_until: "",
    approval_required: false,
  }
}

export function TaskFormDialog({
  open,
  onOpenChange,
  meta,
  initial,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meta?: TaskMeta
  initial?: Partial<TaskFormValue> & { id?: number }
  onSaved: () => void
}) {
  const [value, setValue] = useState<TaskFormValue>(emptyValue(meta))
  const [saving, setSaving] = useState(false)
  const isEdit = Boolean(initial?.id)

  useEffect(() => {
    if (!open) return
    setValue({
      ...emptyValue(meta),
      ...initial,
      start_date: toDateInput(initial?.start_date),
      due_date: toDateInput(initial?.due_date),
      recurrence_until: toDateInput(initial?.recurrence_until),
    })
  }, [open, initial, meta])

  function set<K extends keyof TaskFormValue>(key: K, v: TaskFormValue[K]) {
    setValue((prev) => ({ ...prev, [key]: v }))
  }

  async function submit() {
    if (!value.title.trim()) {
      toast.error("Title is required")
      return
    }
    setSaving(true)
    try {
      const assignee = meta?.users.find((u) => String(u.id) === value.assignee_id)
      const team = meta?.teams.find((t) => String(t.id) === value.team_id)
      const payload = {
        title: value.title.trim(),
        description: value.description.trim() || null,
        task_type: value.task_type,
        status: value.status,
        priority: value.priority,
        assignee_id: value.assignee_id ? Number(value.assignee_id) : null,
        assignee_name: assignee?.name ?? null,
        team_id: value.team_id ? Number(value.team_id) : null,
        team_name: team?.name ?? null,
        start_date: value.start_date || null,
        due_date: value.due_date || null,
        recurrence: value.recurrence,
        recurrence_interval: Number(value.recurrence_interval) || 1,
        recurrence_until: value.recurrence_until || null,
        approval_required: value.approval_required,
      }
      const res = await fetch(isEdit ? `/api/tasks/${initial!.id}` : "/api/tasks", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Failed to save task")
      }
      toast.success(isEdit ? "Task updated" : "Task created")
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Define the work, who owns it, and how it should be tracked.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={value.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="What needs to be done?"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-desc">Description</Label>
            <Textarea
              id="task-desc"
              value={value.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Add context, acceptance criteria, links…"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <PickField label="Type">
              <Select value={value.task_type} onValueChange={(v) => set("task_type", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.types ?? []).map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
            <PickField label="Priority">
              <Select value={value.priority} onValueChange={(v) => set("priority", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.priorities ?? []).map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <PickField label="Assignee">
              <Select
                value={value.assignee_id || UNSET}
                onValueChange={(v) => set("assignee_id", v === UNSET ? "" : v)}
              >
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>Unassigned</SelectItem>
                  {(meta?.users ?? []).map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
            <PickField label="Team">
              <Select
                value={value.team_id || UNSET}
                onValueChange={(v) => set("team_id", v === UNSET ? "" : v)}
              >
                <SelectTrigger><SelectValue placeholder="No team" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>No team</SelectItem>
                  {(meta?.teams ?? []).map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <PickField label="Start date">
              <Input type="date" value={value.start_date} onChange={(e) => set("start_date", e.target.value)} />
            </PickField>
            <PickField label="Due date">
              <Input type="date" value={value.due_date} onChange={(e) => set("due_date", e.target.value)} />
            </PickField>
          </div>

          {isEdit && (
            <PickField label="Status">
              <Select value={value.status} onValueChange={(v) => set("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.statuses ?? []).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
          )}

          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <PickField label="Recurrence">
              <Select value={value.recurrence} onValueChange={(v) => set("recurrence", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.recurrences ?? ["none", "daily", "weekly", "monthly"]).map((r) => (
                    <SelectItem key={r} value={r}>{r === "none" ? "Does not repeat" : r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PickField>
            {value.recurrence !== "none" && (
              <div className="grid grid-cols-2 gap-3">
                <PickField label="Every (interval)">
                  <Input
                    type="number"
                    min={1}
                    value={value.recurrence_interval}
                    onChange={(e) => set("recurrence_interval", e.target.value)}
                  />
                </PickField>
                <PickField label="Until (optional)">
                  <Input
                    type="date"
                    value={value.recurrence_until}
                    onChange={(e) => set("recurrence_until", e.target.value)}
                  />
                </PickField>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="task-approval">Requires approval</Label>
              <p className="text-xs text-muted-foreground">
                Task cannot be completed until an approver signs off.
              </p>
            </div>
            <Switch
              id="task-approval"
              checked={value.approval_required}
              onCheckedChange={(v) => set("approval_required", v)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
