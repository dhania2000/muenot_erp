"use client"

import { useMemo, useState } from "react"
import { FileText, PenTool, Plus, Search } from "lucide-react"

type LegalKind = "contracts" | "esign"

type Field = { name: string; label: string; type?: "text" | "date" | "textarea" | "select"; options?: string[] }

const config: Record<
  LegalKind,
  {
    title: string
    eyebrow: string
    description: string
    action: string
    icon: typeof FileText
    fields: Field[]
    columns: string[]
    cards: { label: string; value: string }[]
    statuses: string[]
  }
> = {
  contracts: {
    title: "Contracts",
    eyebrow: "Legal workspace",
    description: "Draft, track, and store legal agreements with clients and vendors.",
    action: "New contract",
    icon: FileText,
    fields: [
      { name: "title", label: "Contract title" },
      { name: "party", label: "Counterparty" },
      { name: "type", label: "Type", type: "select", options: ["Service Agreement", "NDA", "MSA", "SOW", "Vendor", "Other"] },
      { name: "value", label: "Contract value" },
      { name: "start", label: "Start date", type: "date" },
      { name: "end", label: "End date", type: "date" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    columns: ["Contract", "Counterparty", "Type", "End date", "Status"],
    cards: [
      { label: "Total contracts", value: "0" },
      { label: "Active", value: "0" },
      { label: "Expiring soon", value: "0" },
    ],
    statuses: ["Draft", "In review", "Active", "Expired"],
  },
  esign: {
    title: "Esign",
    eyebrow: "Legal workspace",
    description: "Send documents for electronic signature and track their progress.",
    action: "New signature request",
    icon: PenTool,
    fields: [
      { name: "document", label: "Document name" },
      { name: "signer", label: "Signer name" },
      { name: "email", label: "Signer email" },
      { name: "role", label: "Role", type: "select", options: ["Client", "Vendor", "Employee", "Witness", "Other"] },
      { name: "due", label: "Due date", type: "date" },
      { name: "message", label: "Message", type: "textarea" },
    ],
    columns: ["Document", "Signer", "Role", "Due date", "Status"],
    cards: [
      { label: "Total requests", value: "0" },
      { label: "Awaiting signature", value: "0" },
      { label: "Completed", value: "0" },
    ],
    statuses: ["Draft", "Sent", "Signed", "Declined"],
  },
}

export function LegalWorkspace({ kind }: { kind: LegalKind }) {
  const item = config[kind]
  const Icon = item.icon
  const [showForm, setShowForm] = useState(false)
  const [saved, setSaved] = useState(false)
  const [q, setQ] = useState("")

  const gridCols = useMemo(() => `repeat(${item.columns.length}, minmax(0, 1fr))`, [item.columns.length])

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="size-5" />
          </span>
          <div>
            <p className="text-sm text-muted-foreground">{item.eyebrow}</p>
            <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
          </div>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus className="size-4" />
          {item.action}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {item.cards.map((card) => (
          <section key={card.label} className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-3 text-3xl font-semibold">{card.value}</p>
          </section>
        ))}
      </div>

      {showForm && (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-lg font-semibold">{item.action}</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {item.fields.map((field) =>
              field.type === "textarea" ? (
                <textarea
                  key={field.name}
                  className="min-h-24 rounded-md border border-input bg-background p-3 text-sm md:col-span-2 lg:col-span-3"
                  placeholder={field.label}
                />
              ) : field.type === "select" ? (
                <select key={field.name} className="rounded-md border border-input bg-background p-3 text-sm">
                  <option value="">{field.label}</option>
                  {field.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={field.name}
                  type={field.type === "date" ? "date" : "text"}
                  className="rounded-md border border-input bg-background p-3 text-sm"
                  placeholder={field.label}
                />
              ),
            )}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => setSaved(true)}
            >
              {saved ? "Saved" : "Save record"}
            </button>
            <button
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              onClick={() => {
                setShowForm(false)
                setSaved(false)
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <h2 className="font-semibold">{item.title} records</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${item.title.toLowerCase()}...`}
              className="w-64 max-w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[720px] gap-4 px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: gridCols }}
          >
            {item.columns.map((column) => (
              <div key={column}>{column}</div>
            ))}
          </div>
          <div className="border-t border-border p-10 text-center text-sm text-muted-foreground">
            No records yet. Use &ldquo;{item.action}&rdquo; to add your first entry.
          </div>
        </div>
      </section>
    </main>
  )
}
