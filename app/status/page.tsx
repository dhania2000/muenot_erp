import type { Metadata } from "next"
import { getPublicStatus, type PublicIncident, type PublicStatus } from "@/lib/status/service"
import type { ComponentStatus } from "@/lib/status/model"

export const dynamic = "force-dynamic"
export const metadata: Metadata = {
  title: "System status · Muenot",
  description: "Live component status, incidents and scheduled maintenance for Muenot ERP.",
}

const DOT: Record<ComponentStatus, string> = {
  operational: "bg-emerald-500",
  unknown: "bg-muted-foreground/40",
  maintenance: "bg-sky-500",
  degraded: "bg-amber-500",
  partial_outage: "bg-orange-500",
  major_outage: "bg-red-600",
}

function when(iso: string | null) {
  if (!iso) return ""
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
}

function IncidentCard({ incident }: { incident: PublicIncident }) {
  return (
    <article className="rounded-lg border border-border bg-background p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{incident.title}</h3>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium capitalize">{incident.status}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {incident.reference} · {incident.impact} impact · started {when(incident.startedAt)}
      </p>
      {incident.updates.length > 0 && (
        <ol className="mt-4 flex flex-col gap-3 border-l border-border pl-4">
          {incident.updates.map((u, i) => (
            <li key={i} className="text-sm">
              <p className="leading-relaxed">{u.message}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{when(u.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

/** Spec28 (#126) — Public status page built from measured health and DR incidents. */
export default async function StatusPage() {
  let status: PublicStatus | null = null
  try {
    status = await getPublicStatus()
  } catch (error) {
    console.error("[status] page failed", error)
  }

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-12">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header>
          <p className="text-sm font-medium text-muted-foreground">Muenot ERP</p>
          <h1 className="mt-1 text-3xl font-semibold">System status</h1>
        </header>

        {!status ? (
          <p role="alert" className="rounded-lg border border-border bg-background p-5 text-sm">
            Status is temporarily unavailable. Please try again shortly.
          </p>
        ) : (
          <>
            <section aria-label="Overall status" className="flex items-center gap-3 rounded-lg border border-border bg-background p-5">
              <span className={`size-3 rounded-full ${DOT[status.overall]}`} aria-hidden="true" />
              <p className="font-semibold">{status.overallLabel}</p>
              <p className="ml-auto text-xs text-muted-foreground">Updated {when(status.generatedAt)}</p>
            </section>

            {status.maintenance.length > 0 && (
              <section aria-labelledby="mw" className="flex flex-col gap-3">
                <h2 id="mw" className="text-lg font-semibold">Maintenance</h2>
                {status.maintenance.map((m, i) => (
                  <div key={i} className="rounded-lg border border-sky-500/40 bg-background p-5">
                    <p className="font-medium">
                      {m.title} <span className="text-xs font-normal text-muted-foreground">({m.phase === "active" ? "in progress" : "scheduled"})</span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{m.message}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {when(m.startsAt)}
                      {m.endsAt ? ` – ${when(m.endsAt)}` : ""}
                    </p>
                  </div>
                ))}
              </section>
            )}

            <section aria-labelledby="components">
              <h2 id="components" className="mb-3 text-lg font-semibold">Components</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-background">
                {status.components.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
                    <span className="font-medium">{c.label}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className={`size-2 rounded-full ${DOT[c.status]}`} aria-hidden="true" />
                      {c.statusLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="active" className="flex flex-col gap-3">
              <h2 id="active" className="text-lg font-semibold">Active incidents</h2>
              {status.activeIncidents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active incidents.</p>
              ) : (
                status.activeIncidents.map((i) => <IncidentCard key={i.reference} incident={i} />)
              )}
            </section>

            {status.recentIncidents.length > 0 && (
              <section aria-labelledby="recent" className="flex flex-col gap-3">
                <h2 id="recent" className="text-lg font-semibold">Recently resolved</h2>
                {status.recentIncidents.map((i) => <IncidentCard key={i.reference} incident={i} />)}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}
