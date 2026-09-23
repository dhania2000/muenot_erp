"use client"

/**
 * SPEC 81 (Global Search) + SPEC 82 (Command Palette).
 *
 * One ⌘K / Ctrl+K surface that unifies:
 *   - navigation across every workspace module the viewer can see
 *     (built from the same permission-filtered sidebar nav),
 *   - permitted quick-create / action commands,
 *   - tenant-wide, permission-scoped record search via /api/search/global,
 *   - recent selections (per browser).
 *
 * There is intentionally only one global search system: the header search
 * button and the keyboard shortcut both open this component, so the two do not
 * visually compete (per SPEC 82).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowRight,
  Briefcase,
  Building2,
  CornerDownLeft,
  FileText,
  Folder,
  History,
  ListChecks,
  Loader2,
  Package,
  Plus,
  Receipt,
  Search,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

type FlatNav = { label: string; href: string }

export type QuickCommand = {
  label: string
  href: string
  hint?: string
  /** "create" rows are grouped under "Create"; everything else under "Quick actions". */
  kind?: "create" | "action"
}

type SearchHit = { id: string | number; title: string; subtitle: string; meta: string }
type SearchGroup = { key: string; label: string; href: string; results: SearchHit[] }

type Selectable = {
  id: string
  label: string
  sublabel?: string
  meta?: string
  groupKey: string
  href: string
  onSelect: () => void
}

const RECENT_KEY = "muenot.command.recent.v1"
const MAX_RECENT = 6

const groupIcon: Record<string, typeof Search> = {
  navigation: ArrowRight,
  create: Plus,
  commands: Plus,
  recent: History,
  employees: UsersRound,
  leads: Briefcase,
  companies: Building2,
  customers_vendors: Users,
  invoices: Receipt,
  expenses: Wallet,
  assets: Package,
  projects: Folder,
  tasks: ListChecks,
  deals: Briefcase,
  documents: FileText,
  reports: FileText,
}

function GroupIcon({ groupKey, className }: { groupKey: string; className?: string }) {
  const Icon = groupIcon[groupKey] ?? FileText
  return <Icon className={className} aria-hidden />
}

type RecentEntry = { label: string; sublabel?: string; href: string; groupKey: string }

function loadRecent(): RecentEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function saveRecent(entry: RecentEntry) {
  if (typeof window === "undefined") return
  try {
    const current = loadRecent().filter((e) => e.href !== entry.href)
    const next = [entry, ...current].slice(0, MAX_RECENT)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — recents are best-effort only */
  }
}

export function CommandPalette({
  open,
  onOpenChange,
  navItems,
  quickCommands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  navItems: FlatNav[]
  quickCommands: QuickCommand[]
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle")
  const [activeIndex, setActiveIndex] = useState(0)
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state whenever the palette is opened.
  useEffect(() => {
    if (open) {
      setRecent(loadRecent())
      setActiveIndex(0)
    } else {
      setQuery("")
      setDebounced("")
      setGroups([])
      setStatus("idle")
    }
  }, [open])

  // Debounce the query that drives the record search.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220)
    return () => clearTimeout(t)
  }, [query])

  // Fetch permission-scoped records for queries of two or more characters.
  useEffect(() => {
    if (!open) return
    if (debounced.length < 2) {
      setGroups([])
      setStatus("idle")
      return
    }
    const controller = new AbortController()
    setStatus("loading")
    fetch(`/api/search/global?q=${encodeURIComponent(debounced)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { groups?: SearchGroup[] }) => {
        setGroups(Array.isArray(data.groups) ? data.groups : [])
        setStatus("done")
      })
      .catch((err) => {
        if (err?.name === "AbortError") return
        setGroups([])
        setStatus("error")
      })
    return () => controller.abort()
  }, [debounced, open])

  const activate = useCallback(
    (item: Selectable) => {
      saveRecent({ label: item.label, sublabel: item.sublabel, href: item.href, groupKey: item.groupKey })
      onOpenChange(false)
      item.onSelect()
    },
    [onOpenChange],
  )

  // Build the flat, ordered list of selectable rows for the current view.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { key: string; label: string; items: Selectable[] }[] = []

    const navMatches = (q ? navItems.filter((n) => n.label.toLowerCase().includes(q)) : navItems).slice(0, q ? 8 : 6)
    const cmdPool = q ? quickCommands.filter((c) => c.label.toLowerCase().includes(q)) : quickCommands
    const createMatches = cmdPool.filter((c) => c.kind === "create").slice(0, 6)
    const actionMatches = cmdPool.filter((c) => c.kind !== "create").slice(0, q ? 6 : 5)

    if (!q && recent.length > 0) {
      out.push({
        key: "recent",
        label: "Recent",
        items: recent.map((r, i) => ({
          id: `recent:${i}`,
          label: r.label,
          sublabel: r.sublabel,
          groupKey: r.groupKey || "recent",
          href: r.href,
          onSelect: () => router.push(r.href),
        })),
      })
    }

    if (navMatches.length) {
      out.push({
        key: "navigation",
        label: "Navigation",
        items: navMatches.map((n) => ({
          id: `nav:${n.href}`,
          label: n.label,
          groupKey: "navigation",
          href: n.href,
          onSelect: () => router.push(n.href),
        })),
      })
    }

    if (createMatches.length) {
      out.push({
        key: "create",
        label: "Create",
        items: createMatches.map((c) => ({
          id: `create:${c.href}`,
          label: c.label,
          sublabel: c.hint,
          groupKey: "create",
          href: c.href,
          onSelect: () => router.push(c.href),
        })),
      })
    }

    if (actionMatches.length) {
      out.push({
        key: "commands",
        label: "Quick actions",
        items: actionMatches.map((c) => ({
          id: `cmd:${c.href}`,
          label: c.label,
          sublabel: c.hint,
          groupKey: "commands",
          href: c.href,
          onSelect: () => router.push(c.href),
        })),
      })
    }

    for (const g of groups) {
      out.push({
        key: g.key,
        label: g.label,
        items: g.results.map((hit) => ({
          id: `${g.key}:${hit.id}`,
          label: hit.title,
          sublabel: hit.subtitle,
          meta: hit.meta,
          groupKey: g.key,
          href: g.href,
          onSelect: () => router.push(g.href),
        })),
      })
    }

    return out
  }, [query, navItems, quickCommands, recent, groups, router])

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections])

  // Keep the active index in range and scrolled into view.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flatItems.length - 1)))
  }, [flatItems.length])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => (flatItems.length ? (i + 1) % flatItems.length : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => (flatItems.length ? (i - 1 + flatItems.length) % flatItems.length : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) activate(item)
    }
  }

  const hasQuery = query.trim().length > 0
  const searching = debounced.length >= 2
  const noRecords = searching && status === "done" && groups.length === 0

  let runningIndex = -1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12%] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search records, jump to a module, or run a command..."
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search records and commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
          />
          {status === "loading" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
        </div>

        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {sections.length === 0 && !searching && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Start typing to search across your workspace.
            </p>
          )}

          {sections.map((section) => (
            <div key={section.key} className="mb-1.5">
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <GroupIcon groupKey={section.key} className="size-3.5" />
                {section.label}
              </div>
              {section.items.map((item) => {
                runningIndex += 1
                const index = runningIndex
                const active = index === activeIndex
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-index={index}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(item)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <GroupIcon groupKey={item.groupKey} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.sublabel && item.sublabel !== "—" && (
                        <span className="block truncate text-xs text-muted-foreground">{item.sublabel}</span>
                      )}
                    </span>
                    {item.meta && item.meta !== "—" && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {item.meta}
                      </span>
                    )}
                    {active && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  </button>
                )
              })}
            </div>
          ))}

          {status === "loading" && groups.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching records...</p>
          )}
          {status === "error" && (
            <p className="px-3 py-6 text-center text-sm text-destructive">
              Search is temporarily unavailable. Try again in a moment.
            </p>
          )}
          {noRecords && hasQuery && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No records match &ldquo;{query.trim()}&rdquo;.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5">↑</kbd>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5">↓</kbd>
            to navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5">Enter</kbd>
            to open
            <span className="mx-1">·</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5">Esc</kbd>
            to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
