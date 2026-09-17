"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Pencil,
  Send,
  CalendarClock,
  Rocket,
  Copy,
  Trash2,
  MoreHorizontal,
  Loader2,
  CheckCircle2,
  XCircle,
  MessageSquarePlus,
  Plus,
  Clock,
} from "lucide-react"
import { ALLOWED_TRANSITIONS, type PlannerStatus } from "@/lib/marketing/planner-constants"
import {
  StatusBadge,
  PriorityBadge,
  REVIEW_STYLES,
  fmtDate,
  fmtDateTime,
  fmtRelative,
  fmtMoney,
  toDateTimeLocal,
  plannerFetch,
  type PlannerItem,
  type Lookups,
} from "./planner-shared"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => plannerFetch(url)

export function PlannerDetailSheet({
  itemId,
  open,
  onOpenChange,
  lookups,
  perms,
  onEdit,
  onMutated,
}: {
  itemId: number | null
  open: boolean
  onOpenChange: (v: boolean) => void
  lookups?: Lookups
  perms: { canManage: boolean; canPublish: boolean; canApprove: boolean; canAssign: boolean }
  onEdit: (item: PlannerItem) => void
  onMutated: () => void
}) {
  const { data, mutate, isLoading } = useSWR<{ item: PlannerItem }>(
    open && itemId ? `/api/marketing/planner/${itemId}` : null,
    fetcher,
  )
  const item = data?.item

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        {isLoading || !item ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <DetailBody
            item={item}
            lookups={lookups}
            perms={perms}
            onEdit={() => onEdit(item)}
            refresh={() => {
              mutate()
              onMutated()
            }}
            close={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function DetailBody({
  item,
  lookups,
  perms,
  onEdit,
  refresh,
  close,
}: {
  item: PlannerItem
  lookups?: Lookups
  perms: { canManage: boolean; canPublish: boolean; canApprove: boolean; canAssign: boolean }
  onEdit: () => void
  refresh: () => void
  close: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<any>, successMsg?: string) {
    setBusy(true)
    try {
      await fn()
      if (successMsg) toast.success(successMsg)
      refresh()
    } catch (err: any) {
      toast.error(err?.message || "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const nextStatuses = (ALLOWED_TRANSITIONS[item.status as PlannerStatus] || []).filter(
    (s) => s !== "Published", // Published is reached via the explicit publish action
  )

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{item.item_code}</span>
          <StatusBadge status={item.status} />
          {item.is_overdue ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
              <Clock className="size-3" /> Overdue
            </span>
          ) : null}
        </div>
        <SheetTitle className="text-pretty">{item.title}</SheetTitle>
        <SheetDescription>
          {item.content_type} · {item.channel}
        </SheetDescription>
      </SheetHeader>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        {perms.canManage ? (
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        ) : null}

        {perms.canManage && nextStatuses.length > 0 ? (
          <Select
            value=""
            onValueChange={(to) =>
              run(
                () =>
                  plannerFetch(`/api/marketing/planner/${item.id}/transition`, {
                    method: "POST",
                    body: JSON.stringify({ to, row_version: item.row_version }),
                  }),
                `Moved to ${to}`,
              )
            }
          >
            <SelectTrigger size="sm" className="w-[150px]">
              <SelectValue placeholder="Change status" />
            </SelectTrigger>
            <SelectContent>
              {nextStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {perms.canManage ? <ScheduleControl item={item} run={run} busy={busy} /> : null}

        {perms.canPublish || perms.canManage ? (
          <Button
            size="sm"
            onClick={() =>
              run(
                () =>
                  plannerFetch(`/api/marketing/planner/${item.id}/publish`, {
                    method: "POST",
                    body: JSON.stringify({}),
                  }),
                "Published",
              )
            }
            disabled={busy || ["Published", "Completed", "Archived", "Cancelled"].includes(item.status)}
          >
            <Rocket className="size-3.5" /> Publish
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" disabled={busy} />}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {perms.canManage ? (
              <DropdownMenuItem
                onClick={() =>
                  run(
                    () =>
                      plannerFetch(`/api/marketing/planner/${item.id}/review`, {
                        method: "POST",
                        body: JSON.stringify({ action: "submit" }),
                      }),
                    "Submitted for review",
                  )
                }
              >
                <Send className="size-4" /> Submit for review
              </DropdownMenuItem>
            ) : null}
            {perms.canApprove ? (
              <>
                <DropdownMenuItem
                  onClick={() =>
                    run(
                      () =>
                        plannerFetch(`/api/marketing/planner/${item.id}/review`, {
                          method: "POST",
                          body: JSON.stringify({ action: "approve" }),
                        }),
                      "Approved",
                    )
                  }
                >
                  <CheckCircle2 className="size-4" /> Approve
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    run(
                      () =>
                        plannerFetch(`/api/marketing/planner/${item.id}/review`, {
                          method: "POST",
                          body: JSON.stringify({ action: "request_changes", note: "" }),
                        }),
                      "Changes requested",
                    )
                  }
                >
                  <MessageSquarePlus className="size-4" /> Request changes
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() =>
                    run(
                      () =>
                        plannerFetch(`/api/marketing/planner/${item.id}/review`, {
                          method: "POST",
                          body: JSON.stringify({ action: "reject" }),
                        }),
                      "Rejected",
                    )
                  }
                >
                  <XCircle className="size-4" /> Reject
                </DropdownMenuItem>
              </>
            ) : null}
            {perms.canManage ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    run(
                      () => plannerFetch(`/api/marketing/planner/${item.id}/duplicate`, { method: "POST" }),
                      "Duplicated",
                    )
                  }
                >
                  <Copy className="size-4" /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (!confirm(`Delete ${item.item_code}? This cannot be undone.`)) return
                    run(async () => {
                      await plannerFetch(`/api/marketing/planner/${item.id}`, { method: "DELETE" })
                      close()
                    }, "Deleted")
                  }}
                >
                  <Trash2 className="size-4" /> Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {item.review_status && item.review_status !== "None" ? (
        <div
          className={cn(
            "rounded-md px-3 py-2 text-xs font-medium",
            REVIEW_STYLES[item.review_status] ?? "bg-muted text-muted-foreground",
          )}
        >
          Review: {item.review_status}
        </div>
      ) : null}

      <Separator />

      <Tabs defaultValue="details" className="min-h-0 flex-1">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="flex flex-col gap-4 pt-2">
          {item.description ? <p className="text-sm text-pretty">{item.description}</p> : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Meta label="Priority">
              <PriorityBadge priority={item.priority} />
            </Meta>
            <Meta label="Channel">{item.channel}</Meta>
            <Meta label="Start">{fmtDate(item.start_date)}</Meta>
            <Meta label="Due">
              <span className={item.is_overdue ? "text-destructive" : undefined}>{fmtDate(item.due_date)}</span>
            </Meta>
            <Meta label="Publish at">{fmtDateTime(item.publish_at)}</Meta>
            <Meta label="Published">{fmtDateTime(item.published_at)}</Meta>
            <Meta label="Campaign">{item.campaign_name || item.campaign || "—"}</Meta>
            <Meta label="Journey">{item.journey_name || "—"}</Meta>
            <Meta label="Segment">{item.segment_name || "—"}</Meta>
            <Meta label="Owner">{item.owner_name || "—"}</Meta>
            <Meta label="Est. budget">{fmtMoney(item.estimated_budget)}</Meta>
            <Meta label="Actual spend">
              <span className={item.over_budget ? "text-destructive" : undefined}>{fmtMoney(item.actual_spend)}</span>
            </Meta>
          </dl>

          {item.tags && item.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((t) => (
                <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  #{t}
                </span>
              ))}
            </div>
          ) : null}

          {item.brief?.notes ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Creative brief</p>
              <p className="text-sm whitespace-pre-wrap text-pretty">{item.brief.notes}</p>
            </div>
          ) : null}

          <DependenciesSection item={item} canManage={perms.canManage} run={run} busy={busy} />
        </TabsContent>

        <TabsContent value="people" className="pt-2">
          <PeopleSection item={item} lookups={lookups} canAssign={perms.canAssign || perms.canManage} run={run} />
        </TabsContent>

        <TabsContent value="comments" className="pt-2">
          <CommentsSection itemId={item.id} />
        </TabsContent>

        <TabsContent value="activity" className="pt-2">
          <ActivitySection itemId={item.id} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}

function ScheduleControl({
  item,
  run,
  busy,
}: {
  item: PlannerItem
  run: (fn: () => Promise<any>, msg?: string) => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(toDateTimeLocal(item.publish_at))

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
        <CalendarClock className="size-3.5" /> Schedule
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Set publish date & time</p>
        <Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} className="mb-2" />
        <Button
          size="sm"
          className="w-full"
          disabled={!value}
          onClick={() => {
            const publish_at = value.replace("T", " ") + ":00"
            run(
              () =>
                plannerFetch(`/api/marketing/planner/${item.id}/schedule`, {
                  method: "POST",
                  body: JSON.stringify({ publish_at }),
                }),
              "Scheduled",
            )
            setOpen(false)
          }}
        >
          Schedule
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PeopleSection({
  item,
  lookups,
  canAssign,
  run,
}: {
  item: PlannerItem
  lookups?: Lookups
  canAssign: boolean
  run: (fn: () => Promise<any>, msg?: string) => void
}) {
  const employees = lookups?.employees ?? []
  const primary = item.assignee_id ? String(item.assignee_id) : ""

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Primary assignee</span>
        {canAssign ? (
          <Select
            value={primary}
            onValueChange={(v) =>
              run(
                () =>
                  plannerFetch(`/api/marketing/planner/${item.id}/assign`, {
                    method: "POST",
                    body: JSON.stringify({
                      primary: Number(v),
                      contributors: (item.contributors ?? []).map((c) => c.user_id),
                    }),
                  }),
                "Assignee updated",
              )
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium">{item.assignee_name || "Unassigned"}</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Contributors</span>
        {item.contributors && item.contributors.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {item.contributors.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1 text-sm">
                <span>{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">No contributors</span>
        )}
      </div>
    </div>
  )
}

function DependenciesSection({
  item,
  canManage,
  run,
  busy,
}: {
  item: PlannerItem
  canManage: boolean
  run: (fn: () => Promise<any>, msg?: string) => void
  busy: boolean
}) {
  const deps = item.dependencies ?? []
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Blocked by</span>
      {deps.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {deps.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-md border px-2 py-1 text-sm">
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{d.item_code}</span>
                <span className="truncate">{d.title}</span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={d.status} />
                {canManage ? (
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          plannerFetch(`/api/marketing/planner/${item.id}/dependencies?dependsOnId=${d.id}`, {
                            method: "DELETE",
                          }),
                        "Dependency removed",
                      )
                    }
                    aria-label="Remove dependency"
                  >
                    <XCircle className="size-3.5" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-sm text-muted-foreground">No dependencies</span>
      )}
    </div>
  )
}

function CommentsSection({ itemId }: { itemId: number }) {
  const { data, mutate, isLoading } = useSWR<{ comments: any[] }>(
    `/api/marketing/planner/${itemId}/comments`,
    fetcher,
  )
  const [text, setText] = useState("")
  const [posting, setPosting] = useState(false)

  async function post() {
    if (!text.trim()) return
    setPosting(true)
    try {
      await plannerFetch(`/api/marketing/planner/${itemId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: text.trim() }),
      })
      setText("")
      mutate()
    } catch (err: any) {
      toast.error(err?.message || "Failed to comment")
    } finally {
      setPosting(false)
    }
  }

  const comments = data?.comments ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a comment…"
          rows={2}
        />
        <Button size="sm" className="self-end" onClick={post} disabled={posting || !text.trim()}>
          {posting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
          Comment
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-md border p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{c.author_name || c.user_name || "User"}</span>
                <span className="text-xs text-muted-foreground">{fmtRelative(c.created_at)}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-pretty">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ActivitySection({ itemId }: { itemId: number }) {
  const { data, isLoading } = useSWR<{ activity: any[] }>(`/api/marketing/planner/${itemId}/activity`, fetcher)
  const activity = data?.activity ?? []

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (activity.length === 0) return <p className="text-sm text-muted-foreground">No activity recorded.</p>

  return (
    <ul className="flex flex-col gap-0">
      {activity.map((a, i) => (
        <li key={a.id ?? i} className="relative flex gap-3 pb-4 pl-4">
          <span className="absolute top-1.5 left-0 size-2 rounded-full bg-primary" />
          {i < activity.length - 1 ? <span className="absolute top-3 left-[3px] h-full w-px bg-border" /> : null}
          <div className="flex flex-col gap-0.5">
            <p className="text-sm">
              <span className="font-medium">{a.actor_name || a.user_name || "System"}</span>{" "}
              <span className="text-muted-foreground">{a.description || a.action || a.type}</span>
            </p>
            <span className="text-xs text-muted-foreground">{fmtDateTime(a.created_at)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
