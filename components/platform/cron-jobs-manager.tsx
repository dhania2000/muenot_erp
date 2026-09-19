"use client"

import { useEffect, useState } from "react"
import { Clock3, Loader2, Play, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

type Job = {
  key: string
  name: string
  description: string
  endpoint: string
  cron_expression: string
  timezone: string
  start_at: string | null
  end_at: string | null
  enabled: boolean
  retry_limit: number
  timeout_seconds: number
  concurrency_limit: number
  notify_on_failure: boolean
  notification_emails: string | null
  updated_at: string
}

type Run = { id: number; job_key: string; status: string; started_at: string; duration_ms: number | null; error_message: string | null }

export function CronJobsManager() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const response = await fetch("/api/platform/cron-jobs", { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to load scheduled jobs")
      setJobs(data.jobs ?? [])
      setRuns(data.runs ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load scheduled jobs")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  function update(key: string, patch: Partial<Job>) {
    setJobs((current) => current.map((job) => (job.key === key ? { ...job, ...patch } : job)))
  }

  async function save(job: Job) {
    const response = await fetch("/api/platform/cron-jobs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: job.key, config: {
        cron_expression: job.cron_expression, timezone: job.timezone, start_at: job.start_at || null,
        end_at: job.end_at || null, enabled: job.enabled, retry_limit: job.retry_limit,
        timeout_seconds: job.timeout_seconds, concurrency_limit: job.concurrency_limit,
        notify_on_failure: job.notify_on_failure, notification_emails: job.notification_emails || null,
      } }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) { toast.error(data.error || "Unable to save job"); return }
    update(job.key, data.job)
    toast.success(`${job.name} schedule updated`)
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading scheduler configuration…</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
        Only reviewed internal jobs can run. Administrators can change timing and operational policy, but cannot enter
        shell commands, scripts, or arbitrary URLs.
      </div>
      <div className="flex flex-col gap-4">
        {jobs.map((job) => (
          <section key={job.key} className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{job.name}</h2>
                  <Badge variant={job.enabled ? "default" : "secondary"}>{job.enabled ? "Enabled" : "Paused"}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{job.description}</p>
                <code className="mt-2 block text-xs text-muted-foreground">{job.endpoint}</code>
              </div>
              <Button size="sm" onClick={() => void save(job)}><Save className="size-3.5" /> Save</Button>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs font-medium">Cron expression<Input value={job.cron_expression} onChange={(e) => update(job.key, { cron_expression: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Timezone<Input value={job.timezone} onChange={(e) => update(job.key, { timezone: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Start date/time<Input type="datetime-local" value={job.start_at ? job.start_at.slice(0, 16).replace(" ", "T") : ""} onChange={(e) => update(job.key, { start_at: e.target.value ? e.target.value.replace("T", " ") : null })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">End date/time<Input type="datetime-local" value={job.end_at ? job.end_at.slice(0, 16).replace(" ", "T") : ""} onChange={(e) => update(job.key, { end_at: e.target.value ? e.target.value.replace("T", " ") : null })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Retry limit<Input type="number" min={0} max={10} value={job.retry_limit} onChange={(e) => update(job.key, { retry_limit: Number(e.target.value) })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Timeout (seconds)<Input type="number" min={5} max={900} value={job.timeout_seconds} onChange={(e) => update(job.key, { timeout_seconds: Number(e.target.value) })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Concurrency limit<Input type="number" min={1} max={20} value={job.concurrency_limit} onChange={(e) => update(job.key, { concurrency_limit: Number(e.target.value) })} /></label>
              <label className="flex flex-col gap-1 text-xs font-medium">Failure notification emails<Input placeholder="ops@example.com, admin@example.com" value={job.notification_emails ?? ""} onChange={(e) => update(job.key, { notification_emails: e.target.value })} /></label>
            </div>
            <div className="mt-4 flex flex-wrap gap-5 text-sm">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={job.enabled} onChange={(e) => update(job.key, { enabled: e.target.checked })} /> <span className="flex items-center gap-1"><Play className="size-3.5" /> Enabled</span></label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={job.notify_on_failure} onChange={(e) => update(job.key, { notify_on_failure: e.target.checked })} /> Notify on failure</label>
            </div>
          </section>
        ))}
      </div>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><Clock3 className="size-4" /> Recent runs</h2>
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
