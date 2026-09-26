"use client"

import { useState, type FormEvent } from "react"

export type PortalContact = {
  id: number
  name: string
  email: string
  phone: string | null
  role: string
  is_primary: boolean
  receive_invoices: boolean
  receive_dunning: boolean
}

export function BillingContactsPanel({
  contacts,
  onChanged,
}: {
  contacts: PortalContact[]
  onChanged: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(url: string, init: RequestInit) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const fieldMsg = body.fields ? Object.values(body.fields as Record<string, string>)[0] : null
        throw new Error(fieldMsg || body.error || "Request failed")
      }
      await onChanged()
      return true
    } catch (e: any) {
      setError(e.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const ok = await send("/api/billing/contacts", {
      method: "POST",
      body: JSON.stringify({
        name: fd.get("name"),
        email: fd.get("email"),
        phone: fd.get("phone") || null,
        is_primary: fd.get("is_primary") === "on",
      }),
    })
    if (ok) form.reset()
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="contacts">
      <h2 id="contacts" className="text-lg font-semibold text-foreground">
        Billing contacts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">These people receive invoices and payment reminders.</p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 divide-y divide-border">
        {contacts.length === 0 ? (
          <li className="py-3 text-sm text-muted-foreground">No billing contacts yet.</li>
        ) : (
          contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {c.name}
                  {c.is_primary ? (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Primary</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.email}
                  {c.phone ? ` · ${c.phone}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                {!c.is_primary ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      send(`/api/billing/contacts/${c.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ is_primary: true }),
                      })
                    }
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Make primary
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => send(`/api/billing/contacts/${c.id}`, { method: "DELETE" })}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                  aria-label={`Remove ${c.name}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      <form onSubmit={addContact} className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Name
          <input name="name" required className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Email
          <input
            name="email"
            type="email"
            required
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Phone
          <input name="phone" className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input name="is_primary" type="checkbox" className="size-4" />
          Primary
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Add contact
        </button>
      </form>
    </section>
  )
}
