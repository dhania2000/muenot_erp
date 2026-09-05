"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Search, Save, Check, Loader2,
  Building2, MapPin, AppWindow, Coins, CreditCard, Bell, Wallet, Percent,
  FileSignature, TicketCheck, FolderKanban, Clock, CalendarOff, MessageSquare,
  Target, Timer, ListChecks, ShieldCheck, Palette, Blocks, HardDrive, Languages,
  LogIn, CalendarDays, Link2, FileLock2, DatabaseBackup, UserPlus, Boxes,
  Banknote, AlarmClock, Gauge, ShoppingCart, Users, Webhook, UserCog, Settings2,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  companySettingsSections,
  getSectionDefaults,
  type SettingField,
  type SettingSection,
} from "@/lib/company-settings-config"

const icons: Record<string, LucideIcon> = {
  Building2, MapPin, AppWindow, Coins, CreditCard, Bell, Wallet, Percent,
  FileSignature, TicketCheck, FolderKanban, Clock, CalendarOff, MessageSquare,
  Target, Timer, ListChecks, ShieldCheck, Palette, Blocks, HardDrive, Languages,
  LogIn, CalendarDays, Link2, FileLock2, DatabaseBackup, UserPlus, Boxes,
  Banknote, AlarmClock, Gauge, ShoppingCart, Users, Webhook, UserCog,
}

function SectionIcon({ name, className }: { name: string; className?: string }) {
  const Icon = icons[name] ?? Settings2
  return <Icon className={className} />
}

export function CompanySettings() {
  const [activeId, setActiveId] = useState(companySettingsSections[0].id)
  const [search, setSearch] = useState("")
  const [values, setValues] = useState<Record<string, string>>(getSectionDefaults())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch("/api/admin/company-settings")
      .then((r) => (r.ok ? r.json() : { values: {} }))
      .then((data) => {
        if (cancelled || !data?.values) return
        setValues((prev) => ({ ...prev, ...data.values }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const filteredSections = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return companySettingsSections
    return companySettingsSections.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.fields.some((f) => f.label.toLowerCase().includes(q)),
    )
  }, [search])

  const active = useMemo<SettingSection>(
    () => companySettingsSections.find((s) => s.id === activeId) ?? companySettingsSections[0],
    [activeId],
  )

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  async function saveSection() {
    setSaving(true)
    const payload: Record<string, string> = {}
    for (const f of active.fields) payload[f.key] = values[f.key] ?? ""
    try {
      const res = await fetch("/api/admin/company-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: payload }),
      })
      if (!res.ok) throw new Error("save failed")
      setDirty(false)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(0), 2500)
    } catch {
      setSavedAt(-1)
      setTimeout(() => setSavedAt(0), 3500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      {/* Section navigation */}
      <aside className="flex h-fit flex-col gap-3 rounded-xl border border-border bg-card p-3 lg:sticky lg:top-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search settings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search settings"
          />
        </div>
        <nav className="flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto pr-1">
          {filteredSections.map((s) => {
            const isActive = s.id === active.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <SectionIcon
                  name={s.icon}
                  className={cn("size-4 shrink-0", isActive ? "" : "text-muted-foreground")}
                />
                <span className="truncate">{s.label}</span>
              </button>
            )
          })}
          {filteredSections.length === 0 && (
            <p className="px-2.5 py-4 text-sm text-muted-foreground">No settings match &quot;{search}&quot;.</p>
          )}
        </nav>
      </aside>

      {/* Active section form */}
      <section className="flex flex-col rounded-xl border border-border bg-card">
        <header className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <SectionIcon name={active.icon} className="size-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">{active.label}</h2>
              <p className="text-sm text-muted-foreground">{active.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:justify-end">
            {savedAt > 0 && (
              <span className="flex items-center gap-1 text-sm text-emerald-500">
                <Check className="size-4" /> Saved
              </span>
            )}
            {savedAt === -1 && (
              <span className="text-sm text-destructive">Save failed</span>
            )}
            <Button onClick={saveSection} disabled={saving || !dirty}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save changes
            </Button>
          </div>
        </header>

        <div className="grid gap-5 p-5 md:grid-cols-2">
          {active.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              onChange={(v) => setValue(field.key, v)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function Field({
  field,
  value,
  onChange,
}: {
  field: SettingField
  value: string
  onChange: (v: string) => void
}) {
  const id = `set-${field.key}`
  const wrapClass = field.full || field.type === "textarea" ? "md:col-span-2" : ""

  if (field.type === "toggle") {
    const on = value === (field.options?.[0] ?? "Enabled")
    return (
      <div className={cn("flex items-center justify-between gap-4 rounded-lg border border-border px-3.5 py-3", wrapClass)}>
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer">{field.label}</Label>
          {field.help && <p className="mt-0.5 text-xs text-muted-foreground">{field.help}</p>}
        </div>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(on ? (field.options?.[1] ?? "Disabled") : (field.options?.[0] ?? "Enabled"))}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            on ? "bg-primary" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 rounded-full bg-background shadow transition-transform",
              on ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-1.5", wrapClass)}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.type === "textarea" ? (
        <Textarea
          id={id}
          rows={3}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "select" ? (
        <select
          id={id}
          value={value || field.options?.[0] || ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.type === "color" ? (
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="color"
            value={value || "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
          />
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="#6d28d9" />
        </div>
      ) : (
        <Input
          id={id}
          type={
            field.type === "number"
              ? "number"
              : field.type === "email"
                ? "email"
                : field.type === "password"
                  ? "password"
                  : field.type === "time"
                    ? "time"
                    : field.type === "date"
                      ? "date"
                      : field.type === "url"
                        ? "url"
                        : "text"
          }
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  )
}
