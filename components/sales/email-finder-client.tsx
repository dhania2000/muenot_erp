"use client"

import { FormEvent, useState } from "react"
import { Search, ShieldCheck, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"

type Candidate = { email: string; source: string; title: string; confidence: "Possible" | "Likely" }

export function EmailFinderClient() {
  const [form, setForm] = useState({ firstName: "", middleName: "", lastName: "", domain: "" })
  const [results, setResults] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(""); setResults([]); setLoading(true)
    try {
      const response = await fetch("/api/sales/get-email-name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Lookup failed")
      setResults(data.results)
    } catch (err) { setError(err instanceof Error ? err.message : "Lookup failed") } finally { setLoading(false) }
  }

  return <div className="flex max-w-4xl flex-col gap-6">
    <div><h2 className="text-xl font-semibold">Get Email Name</h2><p className="text-sm text-muted-foreground">Find publicly listed company email addresses from a person&apos;s name and company domain.</p></div>
    <Card><CardHeader><CardTitle>Search public sources</CardTitle><CardDescription>Use a business domain such as acme.com. Results are suggestions, not guaranteed identity matches.</CardDescription></CardHeader><CardContent>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2"><Label htmlFor="firstName">First name</Label><Input id="firstName" required value={form.firstName} onChange={e => setForm({...form, firstName: e.target.value})} /></div>
          <div className="flex flex-col gap-2"><Label htmlFor="middleName">Middle name <span className="text-muted-foreground">(optional)</span></Label><Input id="middleName" value={form.middleName} onChange={e => setForm({...form, middleName: e.target.value})} /></div>
          <div className="flex flex-col gap-2"><Label htmlFor="lastName">Last name <span className="text-muted-foreground">(optional)</span></Label><Input id="lastName" value={form.lastName} onChange={e => setForm({...form, lastName: e.target.value})} /></div>
        </div>
        <div className="flex flex-col gap-2"><Label htmlFor="domain">Company domain</Label><Input id="domain" required placeholder="company.com" value={form.domain} onChange={e => setForm({...form, domain: e.target.value})} /></div>
        <Button type="submit" disabled={loading}><Search data-icon="inline-start" />{loading ? "Searching public sources..." : "Find company email"}</Button>
      </form>
    </CardContent></Card>
    {error && <Card><CardContent className="pt-6 text-sm text-destructive">{error}</CardContent></Card>}
    {results.length > 0 && <Card><CardHeader><CardTitle>Possible matches</CardTitle><CardDescription>{results.length} publicly discoverable result(s)</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{results.map((item) => <div key={item.email + item.source} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{item.email}</p><p className="text-sm text-muted-foreground">{item.title}</p><a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={item.source} target="_blank" rel="noreferrer">Public source <ExternalLink className="size-3" /></a></div><Badge variant="secondary"><ShieldCheck className="mr-1 size-3" />{item.confidence}</Badge></div>)}</CardContent></Card>}
  </div>
}
