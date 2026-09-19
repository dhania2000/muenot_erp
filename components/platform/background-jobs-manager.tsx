"use client"

import { useEffect, useState } from "react"
import { Ban, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type Job = {
  id: number
  job_type: string
  tenant_id: number
  status: string
  priority: number
  attempts: number
  max_attempts: number
  available_at: string
  created_at: string
  error_message: string | null
  cancel_requested: boolean
}

type Stats = Record<string, number>
const tone = (status: string) => status === "completed" ? "default" : status === "dead_letter" || status === "failed" ? "destructive" : "secondary" as const

export function BackgroundJobsManager() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [stats, setStats] = useState<Stats>({})
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    try {
      const response = await fetch("/api/platform/background-jobs", { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to load background jobs")
      setJobs(data.jobs ?? [])
      setStats(data.stats ?? {})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load background jobs")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function cancel(job: Job) {
    setCancelling(job.id)
    try {
      const response = await fetch(`/api/platform/background-jobs/${job.id}`, { method: "DELETE" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to cancel job")
      setJobs((current) => current.map((item) => item.id === job.id ? data.job : item))
      toast.success(data.job.status === "cancelled" ? "Job cancelled" : "Cancellation requested")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to cancel job")
    } finally {
      setCancelling(null)
    }
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading background jobs…</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Object.entries(stats).map(([status, count]) => <div key={status} className="rounded-xl border border-border bg-card p-3"><div className="text-xl font-semibold tabular-nums">{count}</div><div className="mt-1 text-xs capitalize text-muted-foreground">{status.replace("_", " ")}</div></div>)}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Only platform super admins can cancel queued or running work.</p>
        <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="size-3.5" /> Refresh</Button>
      </div>
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Job</th><th className="px-4 py-3">Tenant</th><th className="px-4 py-3">Priority</th><th className="px-4 py-3">Attempts</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Action</th></tr></thead>
            <tbody className="divide-y divide-border">
              {jobs.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No background jobs recorded yet.</td></tr> : jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-4 py-3"><div className="font-medium">#{job.id} · {job.job_type}</div><div className="max-w-sm truncate text-xs text-muted-foreground">{job.error_message || job.created_at}</div></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{job.tenant_id || "Platform"}</td>
                  <td className="px-4 py-3">{job.priority}</td>
                  <td className="px-4 py-3">{job.attempts}/{job.max_attempts}</td>
                  <td className="px-4 py-3"><Badge variant={tone(job.status)}>{job.cancel_requested && job.status === "running" ? "Cancelling" : job.status.replace("_", " ")}</Badge></td>
                  <td className="px-4 py-3">{["queued", "running"].includes(job.status) ? <Button variant="outline" size="sm" disabled={cancelling === job.id} onClick={() => void cancel(job)}><Ban className="size-3.5" /> Cancel</Button> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
