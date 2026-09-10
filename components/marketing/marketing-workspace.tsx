"use client"

import { useMemo, useState } from "react"
import { Megaphone, Plus, Search } from "lucide-react"

type MarketingKind = "campaigns"

const CHANNELS = ["Email", "Social", "Paid Ads", "SEO", "Events", "Content", "Other"]
const STATUSES = ["Draft", "Scheduled", "Active", "Paused", "Completed"]

type Campaign = {
  id: string
  name: string
  channel: string
  status: string
  budget: string
  audience: string
  start: string
  end: string
  notes: string
}

const emptyDraft: Omit<Campaign, "id"> = {
  name: "",
  channel: "",
  status: "Draft",
  budget: "",
  audience: "",
  start: "",
  end: "",
  notes: "",
}

const statusStyles: Record<string, string> = {
  Draft: "bg-muted text-muted-foreground",
  Scheduled: "bg-primary/10 text-primary",
  Active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Paused: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Completed: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
}

function formatRange(start: string, end: string) {
  if (!start && !end) return "—"
  return `${start || "—"} → ${end || "—"}`
}

function formatBudget(value: string) {
  const n = Number(value)
  if (!value || Number.isNaN(n)) return "—"
  return n.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
}

export function MarketingWorkspace({ kind = "campaigns" }: { kind?: MarketingKind }) {
  void kind
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [q, setQ] = useState("")

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return campaigns
    return campaigns.filter((c) =>
      [c.name, c.channel, c.status, c.audience].some((v) => v.toLowerCase().includes(term)),
    )
  }, [campaigns, q])

  const stats = useMemo(() => {
    const active = campaigns.filter((c) => c.status === "Active").length
    const scheduled = campaigns.filter((c) => c.status === "Scheduled").length
    const budget = campaigns.reduce((sum, c) => sum + (Number(c.budget) || 0), 0)
    return { total: campaigns.length, active, scheduled, budget }
  }, [campaigns])

  function update<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function save() {
    if (!draft.name.trim()) return
    setCampaigns((list) => [{ ...draft, id: crypto.randomUUID() }, ...list])
    setDraft(emptyDraft)
    setShowForm(false)
  }

  const cards = [
    { label: "Total campaigns", value: String(stats.total) },
    { label: "Active", value: String(stats.active) },
    { label: "Scheduled", value: String(stats.scheduled) },
    { label: "Total budget", value: formatBudget(String(stats.budget)) },
  ]

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Megaphone className="size-5" />
          </span>
          <div>
            <p className="text-sm text-muted-foreground">Marketing workspace</p>
            <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              Plan, launch, and track marketing campaigns across every channel.
            </p>
          </div>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus className="size-4" />
          New campaign
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <section key={card.label} className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-3 text-3xl font-semibold">{card.value}</p>
          </section>
        ))}
      </div>

      {showForm && (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-lg font-semibold">New campaign</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <input
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Campaign name"
              className="rounded-md border border-input bg-background p-3 text-sm"
            />
            <select
              value={draft.channel}
              onChange={(e) => update("channel", e.target.value)}
              className="rounded-md border border-input bg-background p-3 text-sm"
            >
              <option value="">Channel</option>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={draft.status}
              onChange={(e) => update("status", e.target.value)}
              className="rounded-md border border-input bg-background p-3 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              value={draft.budget}
              onChange={(e) => update("budget", e.target.value)}
              type="number"
              min="0"
              placeholder="Budget (INR)"
              className="rounded-md border border-input bg-background p-3 text-sm"
            />
            <input
              value={draft.audience}
              onChange={(e) => update("audience", e.target.value)}
              placeholder="Target audience"
              className="rounded-md border border-input bg-background p-3 text-sm"
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                value={draft.start}
                onChange={(e) => update("start", e.target.value)}
                type="date"
                aria-label="Start date"
                className="rounded-md border border-input bg-background p-3 text-sm"
              />
              <input
                value={draft.end}
                onChange={(e) => update("end", e.target.value)}
                type="date"
                aria-label="End date"
                className="rounded-md border border-input bg-background p-3 text-sm"
              />
            </div>
            <textarea
              value={draft.notes}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Notes"
              className="min-h-24 rounded-md border border-input bg-background p-3 text-sm md:col-span-2 lg:col-span-3"
            />
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={save}
              disabled={!draft.name.trim()}
            >
              Save campaign
            </button>
            <button
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              onClick={() => {
                setShowForm(false)
                setDraft(emptyDraft)
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <h2 className="font-semibold">Campaign records</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search campaigns..."
              className="w-64 max-w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-4 px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <div>Campaign</div>
            <div>Channel</div>
            <div>Status</div>
            <div>Budget</div>
            <div>Schedule</div>
          </div>
          {filtered.length === 0 ? (
            <div className="border-t border-border p-10 text-center text-sm text-muted-foreground">
              {campaigns.length === 0
                ? "No campaigns yet. Use \u201cNew campaign\u201d to add your first entry."
                : "No campaigns match your search."}
            </div>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {filtered.map((c) => (
                <li
                  key={c.id}
                  className="grid min-w-[760px] grid-cols-[2fr_1fr_1fr_1fr_1.5fr] items-center gap-4 px-5 py-4 text-sm"
                >
                  <div>
                    <p className="font-medium">{c.name}</p>
                    {c.audience && <p className="text-xs text-muted-foreground">{c.audience}</p>}
                  </div>
                  <div className="text-muted-foreground">{c.channel || "—"}</div>
                  <div>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        statusStyles[c.status] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="text-muted-foreground">{formatBudget(c.budget)}</div>
                  <div className="text-muted-foreground">{formatRange(c.start, c.end)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  )
}
