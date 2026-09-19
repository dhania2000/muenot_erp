"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { ObservedJob } from "@/lib/job-monitoring"

type Snapshot = { jobs: ObservedJob[]; alerts: ObservedJob[]; summary: Record<string, number>; total: number; checkedAt: string }
export function JobMonitor({ audience }: { audience: "platform" | "tenant" }) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState("")
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let busy = false
    setData(null)
    async function load() {
      if (busy) return
      busy = true
      try {
        const response = await fetch(`/api/${audience === "platform" ? "platform" : "admin"}/job-monitoring?page=${page}`, { cache: "no-store", signal: controller.signal })
        if (!response.ok) throw new Error("Unable to refresh jobs. Please retry.")
        const snapshot = await response.json()
        if (!controller.signal.aborted) { setData(snapshot); setError("") }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to refresh jobs")
      } finally { busy = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 15000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [audience, page, refresh])
  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Job monitoring</h1><p className="text-sm text-muted-foreground">{audience === "tenant" ? "Your tenant’s background jobs" : "Scheduled and background jobs"} · Refreshes every 15 seconds</p></div>
      <Button variant="outline" onClick={() => setRefresh(n => n + 1)}>Refresh</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error} {data && "Showing the last successful refresh."}</p>}
    {!data && !error && <p role="status">Loading jobs…</p>}
    {data && <>
      <p className="text-xs text-muted-foreground">Last checked: {new Date(data.checkedAt).toLocaleString()}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">{Object.entries(data.summary).map(([key, count]) =>
        <div className="rounded-lg border p-3" key={key}><p className="capitalize">{key}</p><p className="text-xl font-semibold">{count}</p></div>)}</div>
      <section aria-live="polite" className={data.alerts.length ? "rounded-lg border border-destructive p-4" : "rounded-lg border p-4"}>
        <h2 className="font-semibold">Alerts</h2>
        <p className="text-sm text-muted-foreground">Failures from the last 24 hours and currently overdue jobs. Up to 20 latest alerts.</p>
        {data.alerts.length === 0 ? <p>No active alerts.</p> : <ul className="mt-2 space-y-1">{data.alerts.map(job =>
          <li key={job.id}>{job.id} · {job.name}: {job.overdue ? "Job is overdue — check the worker." : job.deadLetter ? "Retries exhausted — job needs attention." : job.error}</li>)}</ul>}
      </section>
      <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm">
        <thead><tr>{["Job", "Tenant", "Status", "Retries", "Duration", "Trigger", "Error"].map(label => <th className="p-3" key={label}>{label}</th>)}</tr></thead>
        <tbody>{data.jobs.map(job => <tr key={job.id} className="border-t">
          <td className="p-3">{job.name}<div className="text-xs text-muted-foreground">{job.id}</div></td>
          <td className="p-3">{job.tenantId ?? "Platform"}</td>
          <td className="p-3 capitalize">{job.status}{job.deadLetter && " (dead letter)"}</td>
          <td className="p-3">{job.retries}</td><td className="p-3">{job.durationMs == null ? "—" : `${(job.durationMs / 1000).toFixed(1)}s`}</td>
          <td className="p-3">{job.triggerSource.replaceAll("_", " ")}</td><td className="p-3">{job.error ?? "—"}</td>
        </tr>)}
        {!data.jobs.length && <tr><td colSpan={7} className="p-6 text-center">No jobs found.</td></tr>}</tbody>
      </table></div>
      <div className="flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button><span>Page {page} · {data.total} jobs</span><Button variant="outline" disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}>Next</Button></div>
      <p className="text-xs text-muted-foreground">Retried counts jobs that have started more than one attempt. Background duration includes retry waiting time. Historical trigger sources may be unknown.</p>
    </>}
  </div>
}
