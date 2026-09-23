"use client"

import { useState } from "react"
import type { Release } from "@/lib/mobile-app-releases"

type Form = {
  application: string; platform: string; versionName: string; versionCode: string; minimumVersionCode: string;
  apkUrl: string; apkSize: string; apkSha256: string; releaseNotes: string; forceUpdate: boolean
}
const empty: Form = { application: "muenot-shopkeeper", platform: "android", versionName: "", versionCode: "", minimumVersionCode: "1", apkUrl: "", apkSize: "", apkSha256: "", releaseNotes: "", forceUpdate: false }
function toForm(release: Release): Form { return { application: release.application, platform: release.platform, versionName: release.versionName, versionCode: String(release.versionCode), minimumVersionCode: String(release.minimumVersionCode), apkUrl: release.apkUrl || "", apkSize: release.apkSize == null ? "" : String(release.apkSize), apkSha256: release.apkSha256 || "", releaseNotes: release.releaseNotes.join("\n"), forceUpdate: release.forceUpdate } }
function toPayload(form: Form) { return { application: form.application, platform: form.platform, versionName: form.versionName, versionCode: Number(form.versionCode), minimumVersionCode: Number(form.minimumVersionCode), apkUrl: form.apkUrl, apkSize: form.apkSize ? Number(form.apkSize) : null, apkSha256: form.apkSha256, releaseNotes: form.releaseNotes.split("\n").map(line => line.trim()).filter(Boolean), forceUpdate: form.forceUpdate } }
const inputClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
const buttonClass = "rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"

export function MobileReleaseManager({ initialReleases }: { initialReleases: Release[] }) {
  const [releases, setReleases] = useState(initialReleases)
  const [selected, setSelected] = useState<Release | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Form>(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  function field<K extends keyof Form>(key: K, value: Form[K]) { setForm(current => ({ ...current, [key]: value })) }
  function beginNew() { setSelected(null); setForm(empty); setEditing(true); setError(""); setMessage("") }
  function select(release: Release) { setSelected(release); setForm(toForm(release)); setEditing(false); setError(""); setMessage("") }
  async function refresh(id?: number) {
    const response = await fetch("/api/platform/mobile-app/releases", { cache: "no-store" })
    if (!response.ok) throw new Error("Could not refresh releases.")
    const body: { releases: Release[] } = await response.json()
    setReleases(body.releases)
    if (id) { const current = body.releases.find(item => item.id === id) || null; setSelected(current); if (current) setForm(toForm(current)) }
  }
  async function save() {
    setBusy(true); setError(""); setMessage("")
    try {
      const response = await fetch(selected ? `/api/platform/mobile-app/releases/${selected.id}` : "/api/platform/mobile-app/releases", { method: selected ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toPayload(form)) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Could not save release.")
      await refresh(result.release.id)
      setEditing(false); setMessage(selected ? "Draft updated." : "Draft created. Review it before publishing.")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save release.") } finally { setBusy(false) }
  }
  async function changePublication(publish: boolean) {
    if (!selected || (publish && !window.confirm(`Publish version ${selected.versionName} (code ${selected.versionCode}) to all mobile users?`)) || (!publish && !window.confirm(`Unpublish version ${selected.versionName}? Devices already updated cannot be downgraded.`))) return
    setBusy(true); setError(""); setMessage("")
    try {
      const response = await fetch(`/api/platform/mobile-app/releases/${selected.id}/publication`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publish }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Could not change release status.")
      await refresh(selected.id); setMessage(publish ? "Release published." : "Release unpublished. Public caches may take up to 30 seconds to expire.")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change release status.") } finally { setBusy(false) }
  }
  return <div className="space-y-6">
    <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">APK files are hosted externally; enter a versioned HTTPS .apk URL after verifying its signature and SHA-256.</p><button className={buttonClass} onClick={beginNew}>Create release</button></div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">{message}</p>}
    <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{["Application", "Platform", "Version", "Code", "Status", "Published", "Minimum", "Force", "APK size", "Created"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{releases.map(release => <tr key={release.id} className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => select(release)}><td className="px-3 py-2">Muenot Shopkeeper</td><td className="px-3 py-2">Android</td><td className="px-3 py-2">{release.versionName}</td><td className="px-3 py-2">{release.versionCode}</td><td className="px-3 py-2">{release.status}</td><td className="px-3 py-2">{release.publishedAt || "—"}</td><td className="px-3 py-2">{release.minimumVersionCode}</td><td className="px-3 py-2">{release.forceUpdate ? "Yes" : "No"}</td><td className="px-3 py-2">{release.apkSize == null ? "—" : `${(release.apkSize / 1048576).toFixed(1)} MB`}</td><td className="px-3 py-2">{release.createdAt}</td></tr>)}</tbody></table>{releases.length === 0 && <p className="p-5 text-sm text-muted-foreground">No releases yet. Create a draft to begin.</p>}</div>
    {(editing || selected) && <section className="space-y-4 rounded-lg border border-border bg-background p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{selected ? `Release ${selected.versionName} · ${selected.status}` : "New release draft"}</h2><button className={buttonClass} onClick={() => { setSelected(null); setEditing(false) }}>Close</button></div>
      {editing ? <><div className="grid gap-4 md:grid-cols-2">{([ ["Version name", "versionName"], ["Version code", "versionCode"], ["Minimum supported version code", "minimumVersionCode"], ["APK size (bytes)", "apkSize"], ["Immutable HTTPS APK URL", "apkUrl"], ["APK SHA-256", "apkSha256"] ] as const).map(([label,key]) => <label key={key} className="space-y-1 text-sm"><span>{label}</span><input className={inputClass} value={form[key]} onChange={event => field(key, event.target.value)} inputMode={key.includes("Code") || key === "apkSize" ? "numeric" : undefined} /></label>)}</div><label className="block space-y-1 text-sm"><span>Release notes (one per line)</span><textarea className={inputClass} rows={4} value={form.releaseNotes} onChange={event => field("releaseNotes", event.target.value)} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.forceUpdate} onChange={event => field("forceUpdate", event.target.checked)} /> Mandatory update for all older version codes</label><p className="text-xs text-muted-foreground">Application: Muenot Shopkeeper · Platform: Android. Saves as draft; publishing is separate.</p><button className={buttonClass} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save draft"}</button></> : selected && <><dl className="grid gap-3 text-sm md:grid-cols-2"><div><dt className="text-muted-foreground">APK URL</dt><dd className="break-all">{selected.apkUrl || "—"}</dd></div><div><dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono">{selected.apkSha256 || "—"}</dd></div><div><dt className="text-muted-foreground">Created by</dt><dd>{selected.createdByEmail || (selected.createdBy ? `User #${selected.createdBy}` : "—")}</dd></div><div><dt className="text-muted-foreground">Created at</dt><dd>{selected.createdAt}</dd></div><div><dt className="text-muted-foreground">Published at</dt><dd>{selected.publishedAt || "—"}</dd></div><div><dt className="text-muted-foreground">Release notes</dt><dd>{selected.releaseNotes.join(" · ") || "—"}</dd></div></dl><div className="flex gap-2">{selected.status === "draft" ? <>{!selected.publishedAt && <button className={buttonClass} onClick={() => setEditing(true)}>Edit draft</button>}<button className={buttonClass} disabled={busy} onClick={() => changePublication(true)}>Publish</button></> : <button className={buttonClass} disabled={busy} onClick={() => changePublication(false)}>Unpublish</button>}{selected.apkUrl && <button className={buttonClass} onClick={() => navigator.clipboard.writeText(selected.apkUrl!)}>Copy APK URL</button>}</div></>}
    </section>}
  </div>
}
