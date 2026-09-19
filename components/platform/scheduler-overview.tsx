"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"

type Job = { key: string; name: string; endpoint: string; enabled: boolean }
type Category = { category: string; label: string; jobs: Job[]; configured: boolean }
type Run = { id: number; job_key: string; status: string; started_at: string; duration_ms: number | null; error_message: string | null }

export function SchedulerOverview() {
  const [categories, setCategories] = useState<Category[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void fetch("/api/platform/scheduler", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || "Unable to load scheduler inventory")
        setCategories(data.categories ?? [])
        setRuns(data.runs ?? [])
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Unable to load scheduler inventory"))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading scheduler inventory…</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {categories.map((item) => (
          <section key={item.category} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold">{item.label}</h2>
              <Badge variant={item.configured ? "default" : "secondary"}>{item.jobs.length}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{item.configured ? `${item.jobs.filter((job) => job.enabled).length} enabled` : "Extension slot"}</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {item.jobs.map((job) => <span key={job.key} className="truncate text-xs text-muted-foreground">{job.name}</span>)}
            </div>
          </section>
        ))}
      </div>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Recent central scheduler runs</h2>
        <div className="mt-4 flex flex-col divide-y divide-border">
          {runs.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No scheduler runs recorded yet.</p> : runs.slice(0, 30).map((run) => (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-medium">{run.job_key}</span><span className="text-xs text-muted-foreground">{run.started_at}</span>
              <Badge variant={run.status === "succeeded" ? "default" : run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
              <span className="text-xs text-muted-foreground">{run.duration_ms == null ? "—" : `${run.duration_ms} ms`}{run.error_message ? ` · ${run.error_message}` : ""}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
