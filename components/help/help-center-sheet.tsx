"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR, { mutate as globalMutate } from "swr"
import { ArrowUpRight, BookOpen, CheckCircle2, Circle, Loader2, MinusCircle, Search } from "lucide-react"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

export const UPDATES_KEY = "/api/product-updates"
export const ONBOARDING_KEY = "/api/onboarding"

type HelpTopic = { title: string; description: string; href: string }
type HelpLinks = { module: string; topics: HelpTopic[]; canSearch: boolean }
type Update = { id: number; version: string; title: string; body: string; category: string; publishedAt: string | null; read: boolean }
type Step = { key: string; title: string; description: string; href: string; state: "todo" | "done" | "skipped"; auto: boolean }
type Checklist = { steps: Step[]; completed: number; total: number; percent: number; dismissed: boolean; complete: boolean }

export type HelpTab = "help" | "updates" | "setup"

export function HelpCenterSheet({
  open,
  onOpenChange,
  pathname,
  isAdmin,
  tab,
  onTabChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  pathname: string
  isAdmin: boolean
  tab: HelpTab
  onTabChange: (t: HelpTab) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle>Help center</SheetTitle>
          <SheetDescription>Guides for this page, product updates and workspace setup.</SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(v) => onTabChange(v as HelpTab)} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-3 w-auto">
            <TabsTrigger value="help">Help</TabsTrigger>
            <TabsTrigger value="updates">{"What's new"}</TabsTrigger>
            {isAdmin && <TabsTrigger value="setup">Setup</TabsTrigger>}
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <TabsContent value="help" className="mt-0">{open && <HelpTab pathname={pathname} />}</TabsContent>
            <TabsContent value="updates" className="mt-0">{open && <UpdatesTab />}</TabsContent>
            {isAdmin && <TabsContent value="setup" className="mt-0">{open && <SetupChecklist />}</TabsContent>}
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function HelpTab({ pathname }: { pathname: string }) {
  const { data, error, isLoading } = useSWR<HelpLinks>(`/api/help/links?path=${encodeURIComponent(pathname)}`, fetcher)
  const [q, setQ] = useState("")
  const [submitted, setSubmitted] = useState("")
  const kb = useSWR<{ articles: { id: number; heading: string; summary: string | null }[] }>(
    submitted && data?.canSearch ? `/api/knowledge-base?q=${encodeURIComponent(submitted)}&pageSize=8` : null,
    fetcher,
  )

  return (
    <div className="flex flex-col gap-5">
      {data?.canSearch && (
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setSubmitted(q.trim())
          }}
        >
          <label htmlFor="kb-search" className="sr-only">Search the knowledge base</label>
          <Input id="kb-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the knowledge base" maxLength={120} />
          <Button type="submit" size="icon" aria-label="Search"><Search className="size-4" /></Button>
        </form>
      )}

      {submitted && (
        <section aria-live="polite" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Articles</h3>
          {kb.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {kb.error && <p className="text-sm text-destructive">Search is unavailable right now.</p>}
          {kb.data && kb.data.articles.length === 0 && <p className="text-sm text-muted-foreground">{`No articles match "${submitted}".`}</p>}
          <ul className="flex flex-col gap-1">
            {kb.data?.articles.map((a) => (
              <li key={a.id}>
                <Link href={`/modules/tickets/knowledge-base?article=${a.id}`} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted">
                  <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.heading}</span>
                    {a.summary && <span className="line-clamp-2 text-xs text-muted-foreground">{a.summary}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Help for this page</h3>
        {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {error && <p className="text-sm text-destructive">Could not load help links.</p>}
        <ul className="flex flex-col gap-1">
          {data?.topics.map((t) => (
            <li key={t.href + t.title}>
              <Link href={t.href} className="group flex items-start justify-between gap-3 rounded-md p-2 hover:bg-muted">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="block text-xs text-muted-foreground">{t.description}</span>
                </span>
                <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function UpdatesTab() {
  const { data, error, isLoading, mutate } = useSWR<{ updates: Update[]; unread: number }>(UPDATES_KEY, fetcher)
  const markRead = async (body: { id: number } | { all: true }) => {
    const res = await fetch("/api/product-updates/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) return toast.error("Could not update read state")
    mutate()
  }

  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  if (error) return <p className="text-sm text-destructive">Could not load product updates.</p>
  if (!data?.updates.length) return <p className="text-sm text-muted-foreground">No product updates yet.</p>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{data.unread ? `${data.unread} unread` : "All caught up"}</p>
        {data.unread > 0 && <Button size="sm" variant="ghost" onClick={() => markRead({ all: true })}>Mark all read</Button>}
      </div>
      <ul className="flex flex-col gap-3">
        {data.updates.map((u) => (
          <li key={u.id} className={cn("rounded-lg border border-border p-3", !u.read && "border-primary/40 bg-primary/5")}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono">{`v${u.version}`}</Badge>
              <Badge variant="outline" className="capitalize">{u.category}</Badge>
              {!u.read && <span className="text-xs font-medium text-primary">New</span>}
              {u.publishedAt && <time className="ml-auto text-xs text-muted-foreground" dateTime={u.publishedAt}>{new Date(u.publishedAt).toLocaleDateString()}</time>}
            </div>
            <h3 className="mt-2 text-sm font-semibold">{u.title}</h3>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{u.body}</p>
            {!u.read && (
              <Button size="sm" variant="link" className="mt-1 h-auto px-0" onClick={() => markRead({ id: u.id })}>Mark as read</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SetupChecklist({ compact = false }: { compact?: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<{ checklist: Checklist }>(ONBOARDING_KEY, fetcher)
  const [busy, setBusy] = useState<string | null>(null)

  const patch = async (key: string, body: Record<string, unknown>) => {
    setBusy(key)
    try {
      const res = await fetch(ONBOARDING_KEY, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Update failed")
      mutate({ checklist: json.checklist }, { revalidate: false })
      globalMutate(ONBOARDING_KEY)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed")
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  if (error || !data) return <p className="text-sm text-destructive">Could not load the setup checklist.</p>
  const c = data.checklist

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{c.complete ? "Setup complete" : "Finish setting up your workspace"}</span>
          <span className="text-muted-foreground">{`${c.completed} of ${c.total}`}</span>
        </div>
        <Progress value={c.percent} aria-label={`Setup ${c.percent}% complete`} />
      </div>
      <ol className="flex flex-col gap-2">
        {c.steps.map((s) => (
          <li key={s.key} className="flex items-start gap-3 rounded-lg border border-border p-3">
            {s.state === "done" ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-label="Done" />
            ) : s.state === "skipped" ? (
              <MinusCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Skipped" />
            ) : (
              <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="To do" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", s.state !== "todo" && "text-muted-foreground")}>{s.title}</p>
              {!compact && <p className="text-xs text-muted-foreground">{s.description}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {s.state === "todo" && (
                  <>
                    <Button asChild size="sm" variant="outline"><Link href={s.href}>Open</Link></Button>
                    <Button size="sm" variant="ghost" disabled={busy === s.key} onClick={() => patch(s.key, { step: s.key, state: "done" })}>Mark done</Button>
                    <Button size="sm" variant="ghost" disabled={busy === s.key} onClick={() => patch(s.key, { step: s.key, state: "skipped" })}>Skip</Button>
                  </>
                )}
                {s.state !== "todo" && !s.auto && (
                  <Button size="sm" variant="ghost" disabled={busy === s.key} onClick={() => patch(s.key, { step: s.key, state: "todo" })}>Undo</Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <Button variant="ghost" size="sm" className="self-start" disabled={busy === "dismiss"} onClick={() => patch("dismiss", { dismissed: !c.dismissed })}>
        {c.dismissed ? "Show checklist on dashboard" : "Hide checklist from dashboard"}
      </Button>
    </div>
  )
}
