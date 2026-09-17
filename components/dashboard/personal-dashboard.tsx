"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR, { mutate as globalMutate } from "swr"
import {
  ArrowRight,
  Cake,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  FolderKanban,
  ListTodo,
  Loader2,
  Plus,
  Trash2,
  Users2,
  Wallet,
  TrendingUp,
  UserPlus,
  Settings2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

type Todo = {
  id: number
  title: string
  priority: "low" | "medium" | "high"
  due_date: string | null
  done: boolean
}
type PendingWork = { id: number; title: string; kind: string; priority: string | null; status: string; due_date: string | null; project: string | null }
type Project = { id: number; name: string; client: string | null; role: string; status: string | null; priority: string | null; end_date: string | null }
type Meeting = { id: number; title: string; time: string | null; type: string | null; contact: string | null; status: string | null }
type Birthday = { id: number; name: string; department: string | null; date: string; isToday: boolean; inDays: number }
type ModuleCard = { slug: string; name: string; description: string; features: unknown[] }

type DashboardData = {
  employee: { name: string; department: string | null; designation: string | null }
  todos: Todo[]
  pendingWork: PendingWork[]
  projects: Project[]
  meetings: Meeting[]
  birthdays: Birthday[]
  stats: { openTodos: number; pendingWork: number; activeProjects: number; meetingsToday: number }
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())
const DASH_KEY = "/api/dashboard"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

function priorityTone(priority: string | null): string {
  switch ((priority || "").toLowerCase()) {
    case "high":
    case "critical":
    case "urgent":
      return "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
    case "medium":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
    default:
      return "bg-muted text-muted-foreground border-transparent"
  }
}

function formatDate(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

export function PersonalDashboard({ modules }: { modules: ModuleCard[] }) {
  const { data, isLoading } = useSWR<DashboardData>(DASH_KEY, fetcher)

  const stats = data?.stats ?? { openTodos: 0, pendingWork: 0, activeProjects: 0, meetingsToday: 0 }
  const firstName = (data?.employee.name || "there").split(" ")[0]

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {firstName}
        </h1>
        <p className="text-sm text-muted-foreground">
          {data?.employee.designation || data?.employee.department
            ? [data?.employee.designation, data?.employee.department].filter(Boolean).join(" · ")
            : "Here's what's on your plate today."}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={ListTodo} label="Open to-dos" value={stats.openTodos} href="#todo-list" />
        <StatCard icon={Clock} label="Pending work" value={stats.pendingWork} href="#pending-work" />
        <StatCard icon={FolderKanban} label="Active projects" value={stats.activeProjects} href="#assigned-projects" />
        <StatCard icon={CalendarClock} label="Meetings today" value={stats.meetingsToday} href="/modules/calendar" />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <TodoCard todos={data?.todos ?? []} loading={isLoading} />
          <PendingWorkCard items={data?.pendingWork ?? []} loading={isLoading} />
          <ProjectsCard projects={data?.projects ?? []} loading={isLoading} />
        </div>
        <div className="flex flex-col gap-4">
          <MeetingsCard meetings={data?.meetings ?? []} loading={isLoading} />
          <BirthdaysCard birthdays={data?.birthdays ?? []} loading={isLoading} />
          <ModulesCard modules={modules} />
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  href?: string
}) {
  const content = (
    <CardContent className="flex items-center gap-3 p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <div className="flex flex-col">
        <span className="text-2xl font-semibold leading-none">{value}</span>
        <span className="mt-1 text-xs text-muted-foreground">{label}</span>
      </div>
    </CardContent>
  )

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`${label}: ${value}`}
        className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card className="cursor-pointer transition-all hover:ring-primary/40 hover:shadow-sm">{content}</Card>
      </Link>
    )
  }

  return <Card>{content}</Card>
}

function SectionCard({
  title,
  icon: Icon,
  action,
  children,
  id,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  children: React.ReactNode
  id?: string
}) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-6 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  )
}

function TodoCard({ todos, loading }: { todos: Todo[]; loading: boolean }) {
  const [title, setTitle] = useState("")
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium")
  const [saving, setSaving] = useState(false)

  async function addTodo() {
    const trimmed = title.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await fetch("/api/dashboard/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed, priority }),
      })
      setTitle("")
      setPriority("medium")
      globalMutate(DASH_KEY)
    } finally {
      setSaving(false)
    }
  }

  async function toggle(todo: Todo) {
    await fetch(`/api/dashboard/todos/${todo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !todo.done }),
    })
    globalMutate(DASH_KEY)
  }

  async function remove(id: number) {
    await fetch(`/api/dashboard/todos/${id}`, { method: "DELETE" })
    globalMutate(DASH_KEY)
  }

  const priorities: Array<"low" | "medium" | "high"> = ["low", "medium", "high"]

  return (
    <SectionCard title="My to-do list" icon={ListTodo} id="todo-list">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) addTodo()
          }}
          placeholder="Add a task and press Enter"
          className="flex-1"
        />
        <div className="flex gap-1">
          {priorities.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPriority(p)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                priority === p ? priorityTone(p) : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted",
              )}
            >
              {p}
            </button>
          ))}
          <Button size="icon" onClick={addTodo} disabled={saving || !title.trim()} aria-label="Add task">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col divide-y">
        {loading ? (
          <LoadingRow />
        ) : todos.length === 0 ? (
          <EmptyRow>No tasks yet. Add your first one above.</EmptyRow>
        ) : (
          todos.map((todo) => (
            <div key={todo.id} className="group flex items-center gap-3 py-2.5">
              <Checkbox checked={todo.done} onCheckedChange={() => toggle(todo)} aria-label="Toggle task" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-sm", todo.done && "text-muted-foreground line-through")}>{todo.title}</span>
                {todo.due_date && (
                  <span className="text-xs text-muted-foreground">Due {formatDate(todo.due_date)}</span>
                )}
              </div>
              <Badge variant="outline" className={cn("hidden shrink-0 capitalize sm:inline-flex", priorityTone(todo.priority))}>
                {todo.priority}
              </Badge>
              <button
                type="button"
                onClick={() => remove(todo.id)}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                aria-label="Delete task"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </SectionCard>
  )
}

function PendingWorkCard({ items, loading }: { items: PendingWork[]; loading: boolean }) {
  return (
    <SectionCard title="Pending work" icon={Clock} id="pending-work">
      {loading ? (
        <LoadingRow />
      ) : items.length === 0 ? (
        <EmptyRow>You're all caught up. Nothing pending assigned to you.</EmptyRow>
      ) : (
        <div className="flex flex-col divide-y">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {[item.kind, item.project].filter(Boolean).join(" · ")}
                </span>
              </div>
              {item.due_date && <span className="shrink-0 text-xs text-muted-foreground">{formatDate(item.due_date)}</span>}
              <Badge variant="outline" className={cn("shrink-0", priorityTone(item.priority))}>
                {item.status}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function ProjectsCard({ projects, loading }: { projects: Project[]; loading: boolean }) {
  return (
    <SectionCard title="Assigned projects" icon={FolderKanban} id="assigned-projects">
      {loading ? (
        <LoadingRow />
      ) : projects.length === 0 ? (
        <EmptyRow>No projects assigned to you right now.</EmptyRow>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {projects.map((p) => (
            <div key={p.id} className="flex flex-col gap-1 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium">{p.name}</span>
                {p.priority && (
                  <Badge variant="outline" className={cn("shrink-0 text-[10px]", priorityTone(p.priority))}>
                    {p.priority}
                  </Badge>
                )}
              </div>
              {p.client && <span className="truncate text-xs text-muted-foreground">{p.client}</span>}
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{p.role}</span>
                {p.end_date && <span>Due {formatDate(p.end_date)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function MeetingsCard({ meetings, loading }: { meetings: Meeting[]; loading: boolean }) {
  return (
    <SectionCard title="Today's meetings" icon={CalendarClock}>
      {loading ? (
        <LoadingRow />
      ) : meetings.length === 0 ? (
        <EmptyRow>No meetings scheduled for today.</EmptyRow>
      ) : (
        <div className="flex flex-col divide-y">
          {meetings.map((m) => (
            <div key={m.id} className="flex items-center gap-3 py-2.5">
              <div className="flex w-12 shrink-0 flex-col items-center rounded-md bg-primary/10 py-1 text-primary">
                <span className="text-xs font-semibold">{m.time || "--:--"}</span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{m.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {[m.contact, m.type].filter(Boolean).join(" · ") || "Meeting"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <Link
        href="/modules/calendar"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        <CalendarDays className="size-3.5" /> Open calendar
      </Link>
    </SectionCard>
  )
}

function BirthdaysCard({ birthdays, loading }: { birthdays: Birthday[]; loading: boolean }) {
  return (
    <SectionCard title="Birthdays" icon={Cake}>
      {loading ? (
        <LoadingRow />
      ) : birthdays.length === 0 ? (
        <EmptyRow>No upcoming birthdays.</EmptyRow>
      ) : (
        <div className="flex flex-col divide-y">
          {birthdays.map((b) => (
            <div key={b.id} className="flex items-center gap-3 py-2.5">
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  b.isToday ? "bg-pink-500/15 text-pink-600 dark:text-pink-400" : "bg-muted text-muted-foreground",
                )}
              >
                <Cake className="size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{b.name}</span>
                {b.department && <span className="truncate text-xs text-muted-foreground">{b.department}</span>}
              </div>
              <span className={cn("shrink-0 text-xs", b.isToday ? "font-medium text-pink-600 dark:text-pink-400" : "text-muted-foreground")}>
                {b.isToday ? "Today" : b.inDays === 1 ? "Tomorrow" : formatDate(b.date)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function ModulesCard({ modules }: { modules: ModuleCard[] }) {
  if (modules.length === 0) return null
  return (
    <SectionCard title="Your modules" icon={Settings2}>
      <div className="flex flex-col gap-2">
        {modules.map((m) => {
          const Icon = moduleIcons[m.slug] ?? Settings2
          return (
            <Link
              key={m.slug}
              href={`/modules/${m.slug}`}
              className="group flex items-center gap-3 rounded-lg border p-3 transition-colors hover:border-primary/40"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.name}</span>
                <span className="text-xs text-muted-foreground">
                  {m.features.length} feature{m.features.length === 1 ? "" : "s"}
                </span>
              </div>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          )
        })}
      </div>
    </SectionCard>
  )
}
