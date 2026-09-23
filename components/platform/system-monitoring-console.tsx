"use client"

import { useCallback, useEffect, useState } from "react"

const BASE = "/api/platform/system-monitoring"
const VIEWS = ["dashboard", "logs", "incidents", "health", "alerts", "settings"] as const
type View = typeof VIEWS[number]
type Json = Record<string, any>
const stamp = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—"

export function SystemMonitoringConsole() {
  const [view, setView] = useState<View>("dashboard")
  const [hours, setHours] = useState(24)
  const [data, setData] = useState<Json | null>(null)
  const [detail, setDetail] = useState<Json | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [filters, setFilters] = useState({ search: "", service: "", severity: "", tenantId: "", requestId: "" })
  const [cursor, setCursor] = useState<number | null>(null)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("tenantId")
    if (id && /^[1-9]\d*$/.test(id)) { setFilters((current) => ({ ...current, tenantId: id })); setView("logs") }
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError("")
    const params = new URLSearchParams({ hours: String(hours) })
    if (view === "logs") { Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) }); if (cursor) params.set("cursor", String(cursor)) }
    if (view === "incidents" && cursor) params.set("cursor", String(cursor))
    try {
      const response = await fetch(`${BASE}/${view}?${params}`, { cache: "no-store" })
      if (!response.ok) throw new Error(`Monitoring request failed (${response.status})`)
      setData(await response.json())
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [view, hours, filters, cursor])
  useEffect(() => { void load() }, [load])

  async function openDetail(kind: "logs" | "incidents", id: number) {
    const response = await fetch(`${BASE}/${kind}/${id}`, { cache: "no-store" })
    if (response.ok) setDetail({ ...await response.json(), kind })
  }
  async function act(action: string) {
    if (!detail) return
    const note = action === "note" ? window.prompt("Internal note (no credentials or secrets)") : undefined
    if (action === "note" && !note) return
    const value = action === "priority" ? window.prompt("Priority: P1, P2, P3 or P4") : action === "assign" ? window.prompt("Platform user ID to assign") : undefined
    if (["priority", "assign"].includes(action) && !value) return
    const response = await fetch(`${BASE}/incidents/${detail.id}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note, value }) })
    if (!response.ok) { setError("Incident action failed"); return }
    setDetail(null); void load()
  }

  return <main className="space-y-6 p-6 text-foreground">
    <div><p className="text-sm text-muted-foreground">Super Admin · Operations</p><h1 className="text-3xl font-semibold">System Monitoring</h1><p className="text-muted-foreground">Application-generated diagnostics only. Host infrastructure logs require separate provider access.</p></div>
    <nav className="flex flex-wrap gap-2" aria-label="Monitoring sections">{VIEWS.map((item) => <button key={item} onClick={() => { setView(item); setCursor(null); setDetail(null) }} className={`rounded-md border px-3 py-2 capitalize ${view === item ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{item === "logs" ? "Runtime Logs" : item}</button>)}</nav>
    {error && <p role="alert" className="rounded-md border border-red-500 p-3 text-red-500">{error}</p>}
    {loading && <p aria-live="polite" className="animate-pulse text-muted-foreground">Loading live monitoring data…</p>}
    {!loading && view === "dashboard" && data && <>
      <div className="flex items-center gap-3"><label htmlFor="monitor-range">Range</label><select id="monitor-range" className="rounded border bg-background p-2" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 6, 24, 168, 720].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hour${h > 1 ? "s" : ""}` : `${h / 24} day${h > 24 ? "s" : ""}`}</option>)}</select><span className="text-sm text-muted-foreground">Environment: {data.environment} · System: {data.systemStatus}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[["Open incidents", "openIncidents"], ["Critical incidents", "criticalIncidents"], ["Errors", "errors"], ["Warnings", "warnings"], ["Database errors", "databaseErrors"], ["WhatsApp errors", "whatsappErrors"], ["Failed APIs", "failedApiRequests"], ["Webhook failures", "webhookFailures"], ["Failed jobs", "failedJobs"]].map(([label, key]) => <div key={key} className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold">{Number(data.totals?.[key] || 0)}</p></div>)}</div>
      <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-xl border p-4"><h2 className="font-semibold">Errors over time</h2>{data.trend?.length ? data.trend.map((r: any, i: number) => <div key={i} className="flex justify-between border-b py-2 text-sm"><span>{r.bucket} · {r.severity}</span><span>{r.count}</span></div>) : <p className="py-4 text-muted-foreground">No events in this range.</p>}</section><section className="rounded-xl border p-4"><h2 className="font-semibold">By service</h2>{data.services?.length ? data.services.map((r: any) => <div key={r.service} className="flex justify-between border-b py-2 text-sm"><span>{r.service}</span><span>{r.count}</span></div>) : <p className="py-4 text-muted-foreground">No service errors in this range.</p>}</section></div>
    </>}
    {!loading && view === "logs" && data && <>
      <div className="flex flex-wrap gap-2">{(["search", "service", "tenantId", "requestId"] as const).map((key) => <input key={key} aria-label={key} placeholder={key} className="rounded border bg-background p-2" value={filters[key]} onChange={(e) => { setCursor(null); setFilters({ ...filters, [key]: e.target.value }) }} />)}<select aria-label="Severity" className="rounded border bg-background p-2" value={filters.severity} onChange={(e) => { setCursor(null); setFilters({ ...filters, severity: e.target.value }) }}><option value="">All severities</option>{["WARNING", "ERROR", "CRITICAL", "INFO", "DEBUG"].map((s) => <option key={s}>{s}</option>)}</select><a className="rounded border px-3 py-2" href={`${BASE}/export?${new URLSearchParams({ hours: String(hours), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value))) })}`}>Export CSV (max 100)</a></div>
      <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead><tr className="bg-muted">{["Time", "Severity", "Service", "Operation", "Code", "Message", "Tenant", "Request"].map((h) => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{data.items?.map((r: any) => <tr key={r.id} className="cursor-pointer border-t hover:bg-muted/40" onClick={() => void openDetail("logs", r.id)}><td className="p-3 whitespace-nowrap">{stamp(r.created_at)}</td><td className="p-3">{r.severity}</td><td className="p-3">{r.service}</td><td className="p-3">{r.operation || "—"}</td><td className="p-3">{r.error_code || "—"}</td><td className="p-3">{r.message}</td><td className="p-3">{r.tenant_id || "—"}</td><td className="p-3">{r.request_id || "—"}</td></tr>)}</tbody></table>{!data.items?.length && <p className="p-4 text-muted-foreground">No matching logs.</p>}</div>
      {data.nextCursor && <button className="rounded border px-3 py-2" onClick={() => setCursor(data.nextCursor)}>Next page</button>}
    </>}
    {!loading && view === "incidents" && data && <><div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted"><tr>{["ID", "Status", "Severity", "Service", "Title", "Occurrences", "Tenants", "Last seen"].map((h) => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{data.items?.map((r: any) => <tr key={r.id} onClick={() => void openDetail("incidents", r.id)} className="cursor-pointer border-t hover:bg-muted/40"><td className="p-3">{r.id}</td><td className="p-3">{r.status}</td><td className="p-3">{r.severity}</td><td className="p-3">{r.service}</td><td className="p-3">{r.title}</td><td className="p-3">{r.occurrence_count}</td><td className="p-3">{r.affected_tenant_count}</td><td className="p-3">{stamp(r.last_seen_at)}</td></tr>)}</tbody></table>{!data.items?.length && <p className="p-4 text-muted-foreground">No incidents.</p>}</div>{data.nextCursor && <button className="rounded border px-3 py-2" onClick={() => setCursor(data.nextCursor)}>Next page</button>}</>}
    {!loading && view === "health" && data && <div className="grid gap-3 md:grid-cols-2">{data.checks?.map((c: any) => <div key={c.name} className="rounded-xl border p-4"><div className="flex justify-between"><strong>{c.name}</strong><span>{c.status}</span></div><p className="mt-2 text-sm text-muted-foreground">{c.reason}</p></div>)}</div>}
    {!loading && view === "alerts" && data && <><section className="rounded-xl border p-4"><h2 className="font-semibold">Alert rules</h2>{data.rules?.map((r: any) => <div key={r.id} className="flex items-center justify-between gap-3 border-b py-2"><p>{r.name} · {r.severity} · {r.threshold_count} in {r.window_minutes} min · cooldown {r.cooldown_minutes} min</p><button className="rounded border px-3 py-1" onClick={async () => { const response = await fetch(`${BASE}/alerts/${r.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !r.enabled }) }); if (response.ok) void load(); else setError("Could not update alert rule") }}>{r.enabled ? "Disable" : "Enable"}</button></div>)}{!data.rules?.length && <p className="py-3 text-muted-foreground">No rules configured. Add one below.</p>}</section><form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const response = await fetch(`${BASE}/alerts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.get("name"), severity: f.get("severity"), thresholdCount: Number(f.get("thresholdCount")) }) }); if (response.ok) void load(); else setError("Could not add alert rule") }}><input name="name" required maxLength={120} placeholder="Rule name" className="rounded border bg-background p-2" /><select name="severity" className="rounded border bg-background p-2"><option>ERROR</option><option>CRITICAL</option></select><input name="thresholdCount" type="number" min="1" max="10080" defaultValue="1" className="w-24 rounded border bg-background p-2" /><button className="rounded bg-primary px-3 py-2 text-primary-foreground">Add in-app rule</button></form><section className="rounded-xl border p-4"><h2 className="font-semibold">Recent deliveries</h2>{data.deliveries?.map((d: any) => <button key={d.id} onClick={() => void openDetail("incidents", d.incident_id)} className="block w-full border-b py-2 text-left hover:text-primary">Incident #{d.incident_id} · {d.channel} · {d.status} · {stamp(d.created_at)}</button>)}</section></>}
    {!loading && view === "settings" && data && <form className="grid max-w-xl gap-3 rounded-xl border p-4" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const input = Object.fromEntries([...f.entries()].map(([k, v]) => [k, k === "min_severity" ? v : Number(v)])); const response = await fetch(`${BASE}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); if (response.ok) void load(); else setError("Could not update settings") }}><h2 className="font-semibold">Retention and collection</h2>{["min_severity", "debug_retention_days", "info_retention_days", "warning_retention_days", "error_retention_days", "critical_retention_days", "slow_request_ms"].map((key) => <label key={key} className="flex items-center justify-between gap-3 text-sm"><span>{key.replaceAll("_", " ")}</span>{key === "min_severity" ? <select name={key} defaultValue={data[key]} className="rounded border bg-background p-2">{["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"].map((s) => <option key={s}>{s}</option>)}</select> : <input name={key} type="number" min="1" max="3650" defaultValue={data[key]} className="w-28 rounded border bg-background p-2" />}</label>)}<button className="rounded bg-primary px-4 py-2 text-primary-foreground">Save settings</button></form>}
    {detail && <section aria-label="Monitoring record detail" className="rounded-xl border bg-card p-5"><div className="flex justify-between"><h2 className="text-xl font-semibold">{detail.kind === "logs" ? "Log" : "Incident"} #{detail.id}</h2><button onClick={() => setDetail(null)} aria-label="Close detail">Close</button></div><dl className="mt-4 grid gap-2 text-sm md:grid-cols-2">{Object.entries(detail).filter(([key]) => !["kind", "events", "logs"].includes(key)).map(([key, value]) => <div key={key} className="break-all border-b py-1"><dt className="font-medium">{key}</dt><dd className="text-muted-foreground">{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</dd></div>)}</dl>{detail.kind === "incidents" && <><div className="mt-4 flex flex-wrap gap-2">{["acknowledge", "investigate", "resolve", "ignore", "reopen", "note", "assign", "priority"].map((action) => <button key={action} className="rounded border px-3 py-2 capitalize" onClick={() => void act(action)}>{action}</button>)}</div><h3 className="mt-4 font-semibold">Timeline</h3>{detail.events?.map((event: any) => <p key={event.id} className="border-b py-2 text-sm">{stamp(event.created_at)} · {event.action} · {event.note || ""}</p>)}</>}{detail.kind === "logs" && detail.request_id && <button className="mt-4 rounded border px-3 py-2" onClick={() => void navigator.clipboard.writeText(detail.request_id)}>Copy Reference ID</button>}</section>}
  </main>
}
