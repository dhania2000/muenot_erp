"use client"

import { useState } from "react"
import useSWR from "swr"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Update = {
  id: number
  version: string
  title: string
  body: string
  category: string
  audienceType: "all" | "role" | "plan" | "tenant"
  audienceConfig: { roles?: string[]; plans?: string[]; tenantIds?: number[] }
  status: "draft" | "published" | "archived"
  publishedAt: string | null
  createdAt: string
}

const CATEGORIES = ["feature", "improvement", "fix", "announcement"] as const
const AUDIENCES = [
  { value: "all", label: "Everyone" },
  { value: "role", label: "Specific roles" },
  { value: "plan", label: "Specific plans" },
  { value: "tenant", label: "Specific tenants" },
] as const

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || "Request failed")
  return json
}

function splitList(v: string) {
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

function audienceConfigFor(type: string, raw: string) {
  if (type === "role") return { roles: splitList(raw) }
  if (type === "plan") return { plans: splitList(raw) }
  if (type === "tenant") return { tenantIds: splitList(raw).map(Number) }
  return {}
}

function audienceLabel(u: Update) {
  if (u.audienceType === "role") return `Roles: ${u.audienceConfig.roles?.join(", ")}`
  if (u.audienceType === "plan") return `Plans: ${u.audienceConfig.plans?.join(", ")}`
  if (u.audienceType === "tenant") return `Tenants: ${u.audienceConfig.tenantIds?.join(", ")}`
  return "Everyone"
}

const EMPTY = { version: "", title: "", body: "", category: "feature", audienceType: "all", audienceValues: "" }

export function ProductUpdatesManager() {
  const [status, setStatus] = useState("all")
  const key = `/api/product-updates?scope=manage${status === "all" ? "" : `&status=${status}`}`
  const { data, error, isLoading, mutate } = useSWR<{ updates: Update[] }>(key, fetcher)
  const [form, setForm] = useState(EMPTY)
  // One key per draft so a double-click or network retry cannot create duplicates.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [saving, setSaving] = useState<"draft" | "publish" | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const submit = async (publish: boolean) => {
    setSaving(publish ? "publish" : "draft")
    try {
      const res = await fetch("/api/product-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          version: form.version,
          title: form.title,
          body: form.body,
          category: form.category,
          audienceType: form.audienceType,
          audienceConfig: audienceConfigFor(form.audienceType, form.audienceValues),
          publish,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Could not save the update")
      toast.success(publish ? "Update published" : "Draft saved")
      setForm(EMPTY)
      setIdempotencyKey(crypto.randomUUID())
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the update")
    } finally {
      setSaving(null)
    }
  }

  const act = async (u: Update, action: "publish" | "archive" | "draft" | "delete") => {
    if (action === "delete" && !window.confirm(`Delete "${u.title}"?`)) return
    setBusyId(u.id)
    try {
      const res = await fetch(`/api/product-updates/${u.id}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: action === "delete" ? undefined : JSON.stringify({ action }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Action failed")
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusyId(null)
    }
  }

  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const canSubmit = form.version.trim() && form.title.trim() && form.body.trim() && saving === null

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New release note</CardTitle>
          <CardDescription>Plain text only. Published notes appear in every targeted user&apos;s help panel as unread.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) submit(false)
            }}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="pu-version">Version</Label>
                <Input id="pu-version" placeholder="2027.1.0" value={form.version} onChange={(e) => set("version")(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <Label htmlFor="pu-title">Title</Label>
                <Input id="pu-title" maxLength={200} value={form.title} onChange={(e) => set("title")(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pu-category">Category</Label>
                <Select value={form.category} onValueChange={set("category")}>
                  <SelectTrigger id="pu-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pu-audience">Audience</Label>
                <Select value={form.audienceType} onValueChange={set("audienceType")}>
                  <SelectTrigger id="pu-audience"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((a) => (
                      <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.audienceType !== "all" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="pu-audience-values">
                    {form.audienceType === "tenant" ? "Tenant IDs" : form.audienceType === "role" ? "Roles" : "Plans"} (comma separated)
                  </Label>
                  <Input id="pu-audience-values" value={form.audienceValues} onChange={(e) => set("audienceValues")(e.target.value)} />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pu-body">Details</Label>
              <Textarea id="pu-body" rows={5} maxLength={8000} value={form.body} onChange={(e) => set("body")(e.target.value)} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" variant="outline" disabled={!canSubmit}>
                {saving === "draft" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Save draft
              </Button>
              <Button type="button" disabled={!canSubmit} onClick={() => submit(true)}>
                {saving === "publish" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Publish
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="pu-list-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pu-list-heading" className="text-sm font-medium">All release notes</h2>
          <Tabs value={status} onValueChange={setStatus}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="draft">Drafts</TabsTrigger>
              <TabsTrigger value="published">Published</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data?.updates.length ? (
          <p className="text-sm text-muted-foreground">No release notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.updates.map((u) => (
              <li key={u.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{u.version}</span>
                    <Badge variant={u.status === "published" ? "default" : "secondary"} className="capitalize">{u.status}</Badge>
                    <Badge variant="outline" className="capitalize">{u.category}</Badge>
                  </div>
                  <p className="font-medium text-pretty">{u.title}</p>
                  <p className="text-xs text-muted-foreground">{audienceLabel(u)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {u.status !== "published" && (
                    <Button size="sm" disabled={busyId === u.id} onClick={() => act(u, "publish")}>Publish</Button>
                  )}
                  {u.status === "published" && (
                    <Button size="sm" variant="outline" disabled={busyId === u.id} onClick={() => act(u, "archive")}>Archive</Button>
                  )}
                  {u.status === "archived" && (
                    <Button size="sm" variant="outline" disabled={busyId === u.id} onClick={() => act(u, "draft")}>Move to draft</Button>
                  )}
                  {u.status !== "published" && (
                    <Button size="sm" variant="ghost" disabled={busyId === u.id} onClick={() => act(u, "delete")}>Delete</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
