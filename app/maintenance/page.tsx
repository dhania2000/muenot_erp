import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { Wrench } from "lucide-react"
import { evaluateMaintenanceForSession } from "@/lib/maintenance/enforce"
import { moduleKeyForPath, moduleLabel } from "@/lib/maintenance/model"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Scheduled maintenance · Muenot", robots: { index: false } }

function formatWhen(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
}

/**
 * Spec28 (#125) — Screen shown when middleware rewrites a blocked request.
 * The decision is re-evaluated server-side from the verified session, so a
 * forged `x-maintenance-path` can only change which module is looked up.
 */
export default async function MaintenancePage() {
  const path = (await headers()).get("x-maintenance-path") ?? ""
  const moduleKey = moduleKeyForPath(path)
  const gate = await evaluateMaintenanceForSession(moduleKey).catch(() => null)
  const w = gate?.blocked ? gate.window : null

  const scopeText =
    w?.scope === "module"
      ? `${moduleLabel(w.moduleKey)} is temporarily unavailable.`
      : w?.scope === "tenant"
        ? "Your organisation's workspace is temporarily unavailable."
        : "Muenot is temporarily unavailable."

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-16">
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-8 shadow-sm">
        <span className="flex size-11 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Wrench className="size-5" aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-balance text-2xl font-semibold">{w?.title ?? "Scheduled maintenance"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{scopeText}</p>
        {w ? (
          <>
            <p className="mt-4 text-pretty text-sm leading-relaxed">{w.message || gate?.message}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-muted/60 p-3">
                <dt className="text-xs text-muted-foreground">Started</dt>
                <dd className="mt-0.5 font-medium">{formatWhen(w.startsAt) ?? "Now"}</dd>
              </div>
              <div className="rounded-md bg-muted/60 p-3">
                <dt className="text-xs text-muted-foreground">Expected back</dt>
                <dd className="mt-0.5 font-medium">{formatWhen(w.endsAt) ?? "Shortly"}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="mt-4 text-sm">Maintenance has finished. You can return to your workspace.</p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/dashboard" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Try again
          </Link>
          <Link href="/status" className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
            System status
          </Link>
          <Link href="/support" className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
            Contact support
          </Link>
        </div>
      </div>
    </main>
  )
}
