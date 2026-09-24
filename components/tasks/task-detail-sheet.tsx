"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Trash2,
  Plus,
  Lock,
  Link2,
  Paperclip,
  MessageSquare,
  ShieldCheck,
  Pencil,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { TaskFormDialog } from "./task-form-dialog"
import { PRIORITY_TONE, STATUS_TONE, formatDate, formatDateTime } from "./task-shared"
import type { TaskMeta } from "./task-shared"

type Detail = {
  task: any
  checklist: any[]
  dependencies: any[]
  dependents: any[]
  comments: any[]
  attachments: any[]
  activity: any[]
}

export function TaskDetailSheet({
  taskId,
  meta,
  currentUserId,
  currentUserName,
  onClose,
  onChanged,
}: {
  taskId: number
  meta?: TaskMeta
  currentUserId: number
  currentUserName: string
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<Detail>(`/api/tasks/${taskId}`, fetcher)
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const task = data?.task

  function refresh() {
    mutate()
    onChanged()
  }

  async function call(url: string, options: RequestInit, successMsg?: string) {
    setBusy(true)
    try {
      const res = await fetch(url, options)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Request failed")
      }
      if (successMsg) toast.success(successMsg)
      refresh()
      return true
    } catch (err) {
      toast.error((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(status: string) {
    await call(
      `/api/tasks/${taskId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...task, status }),
      },
      `Marked ${status}`,
    )
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {isLoading || !task ? (
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader className="space-y-0 border-b p-4 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <SheetTitle className="flex items-center gap-2 text-lg">
                    {task.blocked && <Lock className="size-4 shrink-0 text-amber-600" aria-label="Blocked" />}
                    <span className="truncate">{task.title}</span>
                  </SheetTitle>
                  <SheetDescription className="mt-1">
                    {task.task_type} · Reported by {task.reporter_name ?? "—"} · {formatDate(task.created_at)}
                  </SheetDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)} aria-label="Edit task">
                    <Pencil className="size-4" />
                  </Button>
                  <DeleteButton
                    disabled={busy}
                    onConfirm={async () => {
                      const ok = await call(`/api/tasks/${taskId}`, { method: "DELETE" }, "Task deleted")
                      if (ok) onClose()
                    }}
                  />
                  <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
                    <X className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-3">
                <Badge variant="outline" className={PRIORITY_TONE[task.priority] ?? ""}>{task.priority}</Badge>
                <Badge variant="outline" className={STATUS_TONE[task.status] ?? ""}>{task.status}</Badge>
                {task.assignee_name && <Badge variant="secondary">{task.assignee_name}</Badge>}
                {task.team_name && <Badge variant="outline">{task.team_name}</Badge>}
                {task.due_date && <Badge variant="outline">Due {formatDate(task.due_date)}</Badge>}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-3">
                <Select value={task.status} onValueChange={changeStatus}>
                  <SelectTrigger className="h-8 w-40" disabled={busy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(meta?.statuses ?? []).map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-1 items-center gap-2">
                  <Progress value={task.progress ?? 0} className="h-2" />
                  <span className="text-xs tabular-nums text-muted-foreground">{task.progress ?? 0}%</span>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-4">
              {task.description && (
                <p className="mb-4 whitespace-pre-wrap text-sm text-foreground">{task.description}</p>
              )}

              <Tabs defaultValue="checklist">
                <TabsList className="grid w-full grid-cols-5">
                  <TabsTrigger value="checklist" className="gap-1">
                    <span className="hidden sm:inline">Checklist</span>
                    <span className="sm:hidden">✓</span>
                  </TabsTrigger>
                  <TabsTrigger value="deps"><Link2 className="size-4" /></TabsTrigger>
                  <TabsTrigger value="comments"><MessageSquare className="size-4" /></TabsTrigger>
                  <TabsTrigger value="files"><Paperclip className="size-4" /></TabsTrigger>
                  <TabsTrigger value="approval"><ShieldCheck className="size-4" /></TabsTrigger>
                </TabsList>

                <TabsContent value="checklist" className="pt-4">
                  <ChecklistTab taskId={taskId} items={data!.checklist} busy={busy} onCall={call} />
                </TabsContent>
                <TabsContent value="deps" className="pt-4">
                  <DependenciesTab
                    taskId={taskId}
                    deps={data!.dependencies}
                    dependents={data!.dependents}
                    busy={busy}
                    onCall={call}
                  />
                </TabsContent>
                <TabsContent value="comments" className="pt-4">
                  <CommentsTab taskId={taskId} comments={data!.comments} busy={busy} onCall={call} />
                </TabsContent>
                <TabsContent value="files" className="pt-4">
                  <AttachmentsTab taskId={taskId} attachments={data!.attachments} busy={busy} onCall={call} />
                </TabsContent>
                <TabsContent value="approval" className="pt-4">
                  <ApprovalTab task={task} meta={meta} busy={busy} onCall={call} />
                </TabsContent>
              </Tabs>

              <Separator className="my-5" />
              <ActivityLog activity={data!.activity} />
            </div>
          </>
        )}
      </SheetContent>

      {task && (
        <TaskFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          meta={meta}
          initial={{
            id: task.id,
            title: task.title,
            description: task.description ?? "",
            task_type: task.task_type,
            status: task.status,
            priority: task.priority,
            assignee_id: task.assignee_id ? String(task.assignee_id) : "",
            team_id: task.team_id ? String(task.team_id) : "",
            start_date: task.start_date ?? "",
            due_date: task.due_date ?? "",
            recurrence: task.recurrence ?? "none",
            recurrence_interval: String(task.recurrence_interval ?? 1),
            recurrence_until: task.recurrence_until ?? "",
            approval_required: task.approval_required === 1,
          }}
          onSaved={() => {
            setEditOpen(false)
            refresh()
          }}
        />
      )}
    </Sheet>
  )
}

type CallFn = (url: string, options: RequestInit, successMsg?: string) => Promise<boolean>

function ChecklistTab({
  taskId,
  items,
  busy,
  onCall,
}: {
  taskId: number
  items: any[]
  busy: boolean
  onCall: CallFn
}) {
  const [text, setText] = useState("")
  const done = items.filter((i) => i.is_done).length

  return (
    <div className="flex flex-col gap-3">
      {items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {done} of {items.length} complete
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
            <Checkbox
              checked={!!item.is_done}
              disabled={busy}
              onCheckedChange={(v) =>
                onCall(
                  `/api/tasks/${taskId}/checklist`,
                  {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ item_id: item.id, is_done: !!v }),
                  },
                )
              }
            />
            <span className={`flex-1 text-sm ${item.is_done ? "text-muted-foreground line-through" : "text-foreground"}`}>
              {item.item_text}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              aria-label="Delete item"
              onClick={() =>
                onCall(`/api/tasks/${taskId}/checklist?itemId=${item.id}`, { method: "DELETE" })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-muted-foreground">No checklist items yet.</p>}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!text.trim()) return
          const ok = await onCall(`/api/tasks/${taskId}/checklist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_text: text.trim() }),
          })
          if (ok) setText("")
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add checklist item"
          disabled={busy}
        />
        <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Add item">
          <Plus className="size-4" />
        </Button>
      </form>
    </div>
  )
}

function DependenciesTab({
  taskId,
  deps,
  dependents,
  busy,
  onCall,
}: {
  taskId: number
  deps: any[]
  dependents: any[]
  busy: boolean
  onCall: CallFn
}) {
  const { data: meta } = useSWR<{ rows: any[] }>(`/api/tasks?view=all`, fetcher)
  const [pick, setPick] = useState("")
  const candidates = (meta?.rows ?? []).filter(
    (r) => r.id !== taskId && !deps.some((d) => d.id === r.id),
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Blocked by</p>
        {deps.length === 0 && <p className="text-sm text-muted-foreground">No dependencies.</p>}
        {deps.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="outline" className={STATUS_TONE[d.status] ?? ""}>{d.status}</Badge>
              <span className="truncate text-sm">{d.title}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              aria-label="Remove dependency"
              onClick={() => onCall(`/api/tasks/${taskId}/dependencies?dependsOnId=${d.id}`, { method: "DELETE" })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="flex-1" disabled={busy}>
              <SelectValue placeholder="Add a blocking task" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            disabled={busy || !pick}
            aria-label="Add dependency"
            onClick={async () => {
              const ok = await onCall(`/api/tasks/${taskId}/dependencies`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ depends_on_id: Number(pick) }),
              })
              if (ok) setPick("")
            }}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      {dependents.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Blocks these tasks</p>
          {dependents.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
              <Badge variant="outline" className={STATUS_TONE[d.status] ?? ""}>{d.status}</Badge>
              <span className="truncate text-sm">{d.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CommentsTab({
  taskId,
  comments,
  busy,
  onCall,
}: {
  taskId: number
  comments: any[]
  busy: boolean
  onCall: CallFn
}) {
  const [text, setText] = useState("")
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
        {comments.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 rounded-md border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{c.author_name ?? "Unknown"}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(c.created_at)}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={busy}
                  aria-label="Delete comment"
                  onClick={() => onCall(`/api/tasks/${taskId}/comments?commentId=${c.id}`, { method: "DELETE" })}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground">{c.body}</p>
          </div>
        ))}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!text.trim()) return
          const ok = await onCall(`/api/tasks/${taskId}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: text.trim() }),
          })
          if (ok) setText("")
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a comment…"
          rows={2}
          disabled={busy}
        />
        <Button type="submit" size="sm" className="self-end" disabled={busy || !text.trim()}>
          Comment
        </Button>
      </form>
    </div>
  )
}

function AttachmentsTab({
  taskId,
  attachments,
  busy,
  onCall,
}: {
  taskId: number
  attachments: any[]
  busy: boolean
  onCall: CallFn
}) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {attachments.length === 0 && <p className="text-sm text-muted-foreground">No attachments.</p>}
        {attachments.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
            <a
              href={a.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-2 text-sm text-primary hover:underline"
            >
              <Paperclip className="size-3.5 shrink-0" />
              <span className="truncate">{a.file_name}</span>
            </a>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              aria-label="Delete attachment"
              onClick={() => onCall(`/api/tasks/${taskId}/attachments?attachmentId=${a.id}`, { method: "DELETE" })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <form
        className="flex flex-col gap-2 rounded-md border p-2.5"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim() || !url.trim()) return
          const ok = await onCall(`/api/tasks/${taskId}/attachments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_name: name.trim(), file_url: url.trim() }),
          })
          if (ok) {
            setName("")
            setUrl("")
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="File name" disabled={busy} />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={busy} />
        <Button type="submit" size="sm" className="self-end" disabled={busy || !name.trim() || !url.trim()}>
          Attach link
        </Button>
      </form>
    </div>
  )
}

function ApprovalTab({
  task,
  meta,
  busy,
  onCall,
}: {
  task: any
  meta?: TaskMeta
  busy: boolean
  onCall: CallFn
}) {
  const [approver, setApprover] = useState(task.approver_id ? String(task.approver_id) : "")
  const [note, setNote] = useState("")
  const status = task.approval_status as string

  const toneByStatus: Record<string, string> = {
    approved: STATUS_TONE.Done,
    rejected: PRIORITY_TONE.Urgent,
    pending: STATUS_TONE.Blocked,
    none: "",
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Approval status</span>
        <Badge variant="outline" className={toneByStatus[status] ?? ""}>{status}</Badge>
      </div>

      {status === "approved" || status === "rejected" ? (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium text-foreground">
            {status === "approved" ? "Approved" : "Rejected"}
            {task.approver_name ? ` by ${task.approver_name}` : ""}
          </p>
          {task.approval_at && <p className="text-xs text-muted-foreground">{formatDateTime(task.approval_at)}</p>}
          {task.approval_note && <p className="mt-1 whitespace-pre-wrap text-foreground">{task.approval_note}</p>}
        </div>
      ) : status === "pending" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Awaiting sign-off{task.approver_name ? ` from ${task.approver_name}` : ""}.
          </p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional decision note"
            rows={2}
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                onCall(
                  `/api/tasks/${task.id}/approval`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "approve", note: note.trim() || null }),
                  },
                  "Approved",
                )
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                onCall(
                  `/api/tasks/${task.id}/approval`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "reject", note: note.trim() || null }),
                  },
                  "Rejected",
                )
              }
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Send this task for approval. It cannot be marked Done until approved.
          </p>
          <Select value={approver} onValueChange={setApprover}>
            <SelectTrigger disabled={busy}>
              <SelectValue placeholder="Choose an approver" />
            </SelectTrigger>
            <SelectContent>
              {(meta?.users ?? []).map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="self-start"
            disabled={busy || !approver}
            onClick={() => {
              const user = meta?.users.find((u) => String(u.id) === approver)
              onCall(
                `/api/tasks/${task.id}/approval`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "submit",
                    approver_id: Number(approver),
                    approver_name: user?.name ?? null,
                  }),
                },
                "Sent for approval",
              )
            }}
          >
            Submit for approval
          </Button>
        </div>
      )}
    </div>
  )
}

function ActivityLog({ activity }: { activity: any[] }) {
  if (!activity || activity.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Activity</p>
      <ul className="flex flex-col gap-1.5">
        {activity.map((a) => (
          <li key={a.id} className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">{formatDateTime(a.created_at)}</span>
            <span className="text-foreground">
              {a.actor_name ? `${a.actor_name} ` : ""}
              {a.detail || a.action}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DeleteButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled} aria-label="Delete task">
          <Trash2 className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this task?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the task and its checklist, comments, attachments, and dependencies.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
