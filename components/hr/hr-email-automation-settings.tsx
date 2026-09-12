"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"

type EventConfig = {
  event_key: string
  label: string
  group: string
  category: string
  module: string
  variables: string[]
  default_subject: string
  enabled: boolean
  template_id: number | null
  cc_manager: boolean
  updated_at: string | null
}

type Template = { id: number; name: string; category?: string; status?: string }

const NO_TEMPLATE = "__default__"

/** A compact accessible on/off pill (project has no Radix switch installed). */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}

export function HrEmailAutomationSettings() {
  const { data, mutate, isLoading } = useSWR<{ events: EventConfig[]; canManage: boolean }>(
    "/api/hr/emails/automations",
    fetcher,
  )
  const canManage = data?.canManage ?? false
  const { data: templateData } = useSWR<{ templates: Template[] }>(
    "/api/hr/email-templates",
    fetcher,
  )
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const templates = (templateData?.templates ?? []).filter(
    (t) => !t.status || t.status === "Active",
  )
  const groups = useMemo(() => {
    const map = new Map<string, EventConfig[]>()
    for (const ev of data?.events ?? []) {
      const arr = map.get(ev.group) ?? []
      arr.push(ev)
      map.set(ev.group, arr)
    }
    return Array.from(map.entries())
  }, [data])

  async function patch(key: string, body: Record<string, unknown>) {
    if (!canManage) return
    setSavingKey(key)
    setError(null)
    // Optimistic update.
    mutate(
      (prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) =>
                e.event_key === key ? { ...e, ...body } : e,
              ),
            }
          : prev,
      false,
    )
    try {
      const res = await fetch("/api/hr/emails/automations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_key: key, ...body }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || "Update failed")
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      await mutate()
      setSavingKey(null)
    }
  }

  if (isLoading && !data) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading automation rules…</p>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Control which HR workflow events send an automated email, the template they use, and
          whether the reporting manager is CC&apos;d.
        </p>
        {!canManage && (
          <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
            View only
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {groups.map(([group, events]) => (
        <section key={group} className="overflow-hidden rounded-xl border">
          <header className="border-b bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group}
          </header>
          <ul className="divide-y">
            {events.map((ev) => (
              <li
                key={ev.event_key}
                className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Toggle
                      checked={ev.enabled}
                      disabled={!canManage || savingKey === ev.event_key}
                      onChange={(next) => patch(ev.event_key, { enabled: next })}
                      label={`Enable ${ev.label}`}
                    />
                    <span className="font-medium">{ev.label}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {ev.category} · Subject: {ev.default_subject}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 md:justify-end">
                  <Select
                    value={ev.template_id == null ? NO_TEMPLATE : String(ev.template_id)}
                    onValueChange={(v) =>
                      patch(ev.event_key, {
                        template_id: v === NO_TEMPLATE ? null : Number(v),
                      })
                    }
                    disabled={!canManage || !ev.enabled}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="Template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TEMPLATE}>Built-in default</SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Toggle
                      checked={ev.cc_manager}
                      disabled={!canManage || !ev.enabled || savingKey === ev.event_key}
                      onChange={(next) => patch(ev.event_key, { cc_manager: next })}
                      label={`CC manager for ${ev.label}`}
                    />
                    CC manager
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
