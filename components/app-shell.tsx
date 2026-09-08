"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import useSWR from "swr"
import { Bell, ChevronDown, Clock3, FileText, Loader2, LogIn, LogOut, MessageSquare, Plus, Search, Settings, ShieldCheck, StickyNote, Ticket, UserPlus, UsersRound } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { NotesPanel } from "@/components/notes-panel"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type NavChild = {
  label: string
  href: string
}

export type NavItem = {
  label: string
  href: string
  icon: React.ReactNode
  children?: NavChild[]
  /** Render as an external anchor (used by the optional custom sidebar link). */
  external?: boolean
  openInNewTab?: boolean
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type ClockStatus = {
  linked?: boolean
  state?: "in" | "out" | "done"
  clockIn?: string | null
  clockOut?: string | null
}

function formatClockTime(dt: string | null | undefined) {
  if (!dt) return ""
  const d = new Date(dt.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })
}

/** Live ticking watch shown in the header, updated every second on the client. */
function LiveClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Render nothing until mounted to avoid a server/client hydration mismatch.
  if (!now) return null

  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true })
  const date = now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })

  return (
    <div className="mr-1 hidden items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 sm:flex" aria-label="Current time">
      <Clock3 className="size-4 shrink-0 text-primary" />
      <div className="flex flex-col leading-none">
        <span className="font-mono text-sm font-medium tabular-nums text-foreground">{time}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{date}</span>
      </div>
    </div>
  )
}

/** Clock in / clock out control wired to today's attendance record. */
function ClockControl() {
  const { data, mutate, isLoading } = useSWR<ClockStatus>("/api/hr/attendance/clock", fetcher)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = data?.state ?? "out"
  const linked = data?.linked ?? true

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/hr/attendance/clock", { method: "POST" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) setError(json.error || "Something went wrong")
      await mutate()
    } catch {
      setError("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  const dotColor = state === "in" ? "bg-emerald-500" : state === "done" ? "bg-muted-foreground" : "bg-amber-500"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Attendance clock in and out" className="relative text-muted-foreground hover:bg-primary/10 hover:text-primary" />}
      >
        <Clock3 className="size-5" />
        {linked && <span className={cn("absolute right-1 top-1 size-2 rounded-full ring-2 ring-card", dotColor)} />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Attendance</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {isLoading ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">Loading status…</p>
        ) : !linked ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            No employee record is linked to your account. Ask HR to set your official email on your employee profile.
          </p>
        ) : (
          <div className="px-2 py-1.5">
            <div className="mb-3 flex items-center gap-2 text-sm">
              <span className={cn("size-2 rounded-full", dotColor)} />
              {state === "in" && <span>Clocked in at {formatClockTime(data?.clockIn)}</span>}
              {state === "out" && <span className="text-muted-foreground">Not clocked in today</span>}
              {state === "done" && (
                <span className="text-muted-foreground">
                  Clocked out at {formatClockTime(data?.clockOut)}
                </span>
              )}
            </div>

            {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

            {state === "done" ? (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-center text-xs text-muted-foreground">
                Attendance completed for today
              </p>
            ) : (
              <Button
                className="w-full gap-2"
                variant={state === "in" ? "outline" : "default"}
                onClick={toggle}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : state === "in" ? (
                  <LogOut className="size-4" />
                ) : (
                  <LogIn className="size-4" />
                )}
                {state === "in" ? "Clock Out" : "Clock In"}
              </Button>
            )}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NavGroup({
  item,
  pathname,
  open,
  onToggle,
}: {
  item: NavItem
  pathname: string
  open: boolean
  onToggle: () => void
}) {
  const groupActive = pathname === item.href || pathname.startsWith(`${item.href}/`)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          groupActive
            ? "text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <span className="size-4 shrink-0">{item.icon}</span>
        {item.label}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-3 ml-4">
          {item.children!.map((child) => {
            const active = pathname === child.href
            return (
              <Link
                key={child.href}
                href={child.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AppShell({
  navItems,
  user,
  children,
  brandName,
  logoUrl,
}: {
  navItems: NavItem[]
  user: { name: string; email: string; role: "admin" | "employee" }
  children: React.ReactNode
  brandName?: string
  logoUrl?: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [openGroup, setOpenGroup] = useState<string | null>(
    () => navItems.find((i) => i.children?.length && (pathname === i.href || pathname.startsWith(`${i.href}/`)))?.href ?? null,
  )
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [query, setQuery] = useState("")

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/login")
    router.refresh()
  }

  const flatNav = navItems.flatMap((item) =>
    item.children && item.children.length > 0
      ? item.children.map((child) => ({ label: `${item.label} · ${child.label}`, href: child.href }))
      : [{ label: item.label, href: item.href }],
  )
  const searchResults = query.trim()
    ? flatNav.filter((entry) => entry.label.toLowerCase().includes(query.trim().toLowerCase()))
    : flatNav

  function goTo(href: string) {
    setSearchOpen(false)
    setQuery("")
    router.push(href)
  }

  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center px-5 py-5">
          <div className="flex items-center px-1 py-1">
            {logoUrl ? (
              // Company logo from settings can be any host, so use a plain <img>.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl || "/placeholder.svg"} alt={brandName || "Logo"} className="h-6 w-auto max-w-[160px] object-contain" />
            ) : (
              <Image src="/muenot-logo-transparent.png" alt={brandName || "Muenot"} width={112} height={25} className="h-5 w-auto object-contain" priority />
            )}
          </div>
        </div>

        <nav className="min-h-0 flex-1 flex flex-col gap-1 overflow-y-auto px-3">
          {navItems.map((item) => {
            if (item.children && item.children.length > 0) {
              return (
                <NavGroup
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  open={openGroup === item.href}
                  onToggle={() => setOpenGroup((cur) => (cur === item.href ? null : item.href))}
                />
              )
            }
            if (item.external) {
              return (
                <a
                  key={item.href}
                  href={item.href}
                  target={item.openInNewTab ? "_blank" : undefined}
                  rel={item.openInNewTab ? "noopener noreferrer" : undefined}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                >
                  <span className="size-4 shrink-0">{item.icon}</span>
                  {item.label}
                </a>
              )
            }
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <span className="size-4 shrink-0">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="relative border-t border-sidebar-border p-3">
          {profileOpen && (
            <div className="absolute bottom-20 left-3 z-30 w-72 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl">
              <div className="flex items-center gap-3 border-b border-border pb-4">
                <Avatar className="size-11"><AvatarFallback className="bg-primary text-primary-foreground">{initials(user.name)}</AvatarFallback></Avatar>
                <div className="min-w-0"><p className="truncate font-semibold">{user.name}</p><p className="truncate text-xs text-muted-foreground">{user.role === "admin" ? "Administrator" : "Employee"}</p></div>
                <Link href="/profile" className="ml-auto rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Edit profile"><FileText className="size-4" /></Link>
              </div>
              <div className="flex flex-col gap-1 pt-3">
                {user.role === "admin" && <Link href="/modules/hr/employees" className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"><UserPlus className="size-4" /> Add employee</Link>}
                <div className="flex items-center justify-between rounded-md px-2 py-2 text-sm"><span className="flex items-center gap-3"><ThemeToggle /> Dark mode</span></div>
                <button type="button" onClick={handleLogout} className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"><LogOut className="size-4" /> Logout</button>
              </div>
            </div>
          )}
          {user.role === "admin" && (
            <div className="mb-3 flex items-center gap-2 rounded-md bg-sidebar-primary/10 px-3 py-2 text-xs font-medium text-sidebar-primary">
              <ShieldCheck className="size-3.5" />
              Administrator
            </div>
          )}
          <button type="button" onClick={() => setProfileOpen((v) => !v)} aria-expanded={profileOpen} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/60">
            <Avatar className="size-8">
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">{user.email}</span>
            </div>
          </button>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start gap-2 text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground" onClick={handleLogout}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3 md:px-8">
          <div className="flex items-center gap-3"><span className="text-lg font-semibold tracking-tight">{brandName || "Dashboard"}</span></div>
          <div className="flex items-center gap-1">
            <LiveClock />
            <Button variant="ghost" size="icon-sm" aria-label="Search" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => setSearchOpen(true)}><Search className="size-5" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Messages" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => router.push("/modules/messages")}><MessageSquare className="size-5" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Notes and daily tasks" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => setNotesOpen(true)}><StickyNote className="size-5" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Notifications" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" />}>
                <Bell className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-sm text-muted-foreground">You&apos;re all caught up</p>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => router.push("/admin/settings")} aria-label="Settings"><Settings className="size-5" /></Button>
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={handleLogout} aria-label="Sign out"><LogOut className="size-4" /></Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <NotesPanel open={notesOpen} onOpenChange={setNotesOpen} />

      <Dialog open={searchOpen} onOpenChange={(open) => { setSearchOpen(open); if (!open) setQuery("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search</DialogTitle>
          </DialogHeader>
          <Input autoFocus placeholder="Search modules and pages..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pt-2">
            {searchResults.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No results found</p>}
            {searchResults.map((entry) => (
              <button
                key={entry.href}
                type="button"
                onClick={() => goTo(entry.href)}
                className="rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
