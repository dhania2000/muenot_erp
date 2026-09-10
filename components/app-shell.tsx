"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import useSWR from "swr"
import { Bell, ChevronDown, Clock3, FileText, Loader2, LogIn, LogOut, MapPin, MessageSquare, Moon, Plus, RefreshCw, Search, Settings, ShieldCheck, StickyNote, Sun, Ticket, UserPlus, UsersRound } from "lucide-react"
import { useTheme } from "next-themes"
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
  /** Optional for grouping-only nodes that expand into nested children. */
  href?: string
  children?: NavChild[]
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
  state?: "in" | "out"
  clockIn?: string | null
  clockOut?: string | null
  workedHours?: number
}

/** Format a decimal hours value (e.g. 7.25) as "7h 15m". */
function formatWorked(hours: number | null | undefined) {
  if (!hours || hours <= 0) return "0h 0m"
  const total = Math.round(hours * 60)
  return `${Math.floor(total / 60)}h ${total % 60}m`
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

type Geo = { lat: number; lng: number; label: string }

/**
 * Lightweight static map preview built from plain OpenStreetMap tile <img>
 * elements (no interactive iframe / map JS / WebGL). A 3x3 tile grid is
 * positioned so the location sits at the center under a pin. This avoids the
 * renderer crashes that an embedded interactive map iframe can trigger and
 * needs no API key.
 */
function StaticMap({ lat, lng }: { lat: number; lng: number }) {
  const z = 16
  const n = 2 ** z
  const xTile = ((lng + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const x = Math.floor(xTile)
  const y = Math.floor(yTile)
  const offsetX = (xTile - x) * 256
  const offsetY = (yTile - y) * 256

  const deltas = [-1, 0, 1]
  const tiles = deltas.flatMap((dy) => deltas.map((dx) => ({ dx, dy })))

  return (
    <div className="relative h-40 w-full overflow-hidden bg-muted">
      {tiles.map(({ dx, dy }) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${dx}:${dy}`}
          src={`https://tile.openstreetmap.org/${z}/${x + dx}/${y + dy}.png`}
          alt=""
          width={256}
          height={256}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="pointer-events-none absolute left-1/2 top-1/2 select-none"
          style={{
            maxWidth: "none",
            transform: `translate(${dx * 256 - offsetX}px, ${dy * 256 - offsetY}px)`,
          }}
        />
      ))}
      <MapPin className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-full fill-primary text-primary drop-shadow" />
    </div>
  )
}

/**
 * Fetch the browser location and reverse-geocode it to a readable address via
 * OpenStreetMap's Nominatim (no API key required). Resolves to null if the user
 * denies permission or geolocation is unavailable — clock in/out still works.
 */
function getBrowserLocation(): Promise<Geo | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve(null)
      return
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        let label = ""
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
            { headers: { Accept: "application/json" } },
          )
          const json = await res.json()
          label = typeof json?.display_name === "string" ? json.display_name : ""
        } catch {
          // Reverse geocoding is best-effort; coordinates are still captured.
        }
        resolve({ lat, lng, label })
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  })
}

/** Clock in / clock out control wired to today's attendance record. */
function ClockControl() {
  const { data, mutate, isLoading } = useSWR<ClockStatus>("/api/hr/attendance/clock", fetcher)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [geo, setGeo] = useState<Geo | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoDenied, setGeoDenied] = useState(false)

  const state = data?.state ?? "out"
  const linked = data?.linked ?? true

  async function detectLocation() {
    setGeoBusy(true)
    setGeoDenied(false)
    const result = await getBrowserLocation()
    if (result) setGeo(result)
    else setGeoDenied(true)
    setGeoBusy(false)
    return result
  }

  // Auto-detect location when the panel opens and there is a punch to make.
  useEffect(() => {
    if (open && linked && !geo && !geoBusy) {
      void detectLocation()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked, state])

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      // Use the already-detected location, or make a fresh attempt at punch time.
      const location = geo ?? (await detectLocation())
      const res = await fetch("/api/hr/attendance/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          location
            ? { latitude: location.lat, longitude: location.lng, location: location.label }
            : {},
        ),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) setError(json.error || "Something went wrong")
      await mutate()
    } catch {
      setError("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  const dotColor = state === "in" ? "bg-emerald-500" : data?.clockOut ? "bg-muted-foreground" : "bg-amber-500"

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Attendance clock in and out" className="relative text-muted-foreground hover:bg-primary/10 hover:text-primary" />}
      >
        <Clock3 className="size-5" />
        {linked && <span className={cn("absolute right-1 top-1 size-2 rounded-full ring-2 ring-card", dotColor)} />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
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
            <div className="mb-3 flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", dotColor)} />
                {state === "in" ? (
                  <span>Clocked in at {formatClockTime(data?.clockIn)}</span>
                ) : data?.clockOut ? (
                  <span className="text-muted-foreground">Last clocked out at {formatClockTime(data?.clockOut)}</span>
                ) : (
                  <span className="text-muted-foreground">Not clocked in today</span>
                )}
              </div>
              <span className="pl-4 text-xs text-muted-foreground">
                Worked today: <span className="font-medium text-foreground">{formatWorked(data?.workedHours)}</span>
                {" "}(breaks excluded)
              </span>
            </div>

            <div className="mb-3 rounded-md border border-border bg-muted/30 p-2">
              <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <MapPin className="size-3.5 text-primary" />
                    Your location
                  </span>
                  <button
                    type="button"
                    onClick={() => detectLocation()}
                    disabled={geoBusy}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={cn("size-3", geoBusy && "animate-spin")} />
                    {geoBusy ? "Locating…" : "Refresh"}
                  </button>
                </div>

                {geo ? (
                  <>
                    <div className="mb-2 overflow-hidden rounded border border-border">
                      <StaticMap lat={geo.lat} lng={geo.lng} />
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {geo.label || `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`}
                    </p>
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lng}#map=16/${geo.lat}/${geo.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-[11px] text-primary hover:underline"
                    >
                      View on map
                    </a>
                  </>
                ) : geoBusy ? (
                  <p className="text-[11px] text-muted-foreground">Fetching your location…</p>
                ) : geoDenied ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-500">
                    Location unavailable. You can still clock {state === "in" ? "out" : "in"}, but it won&apos;t be recorded.
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Waiting for location permission…</p>
                )}
              </div>

            {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

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
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Prominent text button shown in the header center. No icon — just a clear
 * "Clock In" that flips to "Clock Out" while a session is open, and back to
 * "Clock In" after clocking out so more sessions can be recorded the same day.
 * Shares the SWR cache key with ClockControl so both stay in sync.
 */
function HeaderClockButton() {
  const { data, mutate } = useSWR<ClockStatus>("/api/hr/attendance/clock", fetcher)
  const [busy, setBusy] = useState(false)

  const state = data?.state ?? "out"
  const linked = data?.linked ?? true

  if (!linked) return null

  async function toggle() {
    setBusy(true)
    try {
      const location = await getBrowserLocation()
      await fetch("/api/hr/attendance/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          location ? { latitude: location.lat, longitude: location.lng, location: location.label } : {},
        ),
      })
      await mutate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      onClick={toggle}
      disabled={busy}
      variant={state === "in" ? "outline" : "default"}
      size="sm"
      className="min-w-28 font-medium"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : state === "in" ? "Clock Out" : "Clock In"}
    </Button>
  )
}

/** Full-width theme toggle used inside the profile popover so the whole row is clickable. */
function ThemeModeItem() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const current = theme === "system" ? resolvedTheme : theme
  const isDark = mounted ? current === "dark" : true

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {isDark ? "Light mode" : "Dark mode"}
    </button>
  )
}

/** Recursively determines whether a child (or any descendant) matches the current path. */
function childActive(child: NavChild, pathname: string): boolean {
  if (child.href && (pathname === child.href || pathname.startsWith(`${child.href.split("?")[0]}/`))) {
    // Compare including query so ?kind= variants highlight correctly.
    if (child.href.includes("?")) return pathname + (typeof window !== "undefined" ? window.location.search : "") === child.href
    return true
  }
  return (child.children ?? []).some((c) => childActive(c, pathname))
}

/** Renders a single leaf link or a nested collapsible sub-group within the sidebar. */
function NavChildNode({ child, pathname }: { child: NavChild; pathname: string }) {
  const hasChildren = !!child.children && child.children.length > 0
  const [open, setOpen] = useState(() => (child.children ?? []).some((c) => childActive(c, pathname)))

  if (hasChildren) {
    return (
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          {child.label}
          <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div className="mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-3 ml-2">
            {child.children!.map((c) => (
              <NavChildNode key={c.href ?? c.label} child={c} pathname={pathname} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const active = pathname === child.href
  return (
    <Link
      href={child.href!}
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
          {item.children!.map((child) => (
            <NavChildNode key={child.href ?? child.label} child={child} pathname={pathname} />
          ))}
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

  function flattenChildren(prefix: string, children: NavChild[]): { label: string; href: string }[] {
    return children.flatMap((child) =>
      child.children && child.children.length > 0
        ? flattenChildren(`${prefix} · ${child.label}`, child.children)
        : child.href
          ? [{ label: `${prefix} · ${child.label}`, href: child.href }]
          : [],
    )
  }
  const flatNav = navItems.flatMap((item) =>
    item.children && item.children.length > 0
      ? flattenChildren(item.label, item.children)
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
                <ThemeModeItem />
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
          <HeaderClockButton />
          <div className="flex items-center gap-1">
            <LiveClock />
            <ClockControl />
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
