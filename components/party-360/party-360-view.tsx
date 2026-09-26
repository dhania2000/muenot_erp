"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { AlertTriangle, ExternalLink, Lock, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { PartyKind, SectionResult } from "@/lib/party-360/model"

type Summary = { id: number; name: string; code: string | null; status: string | null; href: string }
type View = {
  id: number
  name: string
  code: string | null
  scope: "full" | "self"
  profile: Record<string, unknown>
  maskedFields: string[]
  recordHref: string
  sections: SectionResult[]
  duplicates: { id: number; name: string; code: string | null; matchedOn: string[]; href: string }[]
  links: { hasLoginAccount?: boolean }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error ?? "Request failed"), { status: res.status })
  return body
}

const STATUS_COPY: Record<string, string> = {
  forbidden: "You don't have access to this module.",
  missing_module: "Module not installed in this workspace.",
  not_linked: "No stable link to this record yet.",
  unscoped: "Hidden: source is not tenant-scoped.",
  error: "Could not load this section.",
}

const label = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

export function Party360View({ kind, title, description }: { kind: PartyKind; title: string; description: string }) {
  const router = useRouter()
  const params = useSearchParams()
  const selected = params.get("id")
  const [search, setSearch] = useState("")

  const list = useSWR<{ items: Summary[]; scope: string }>(
    `/api/party-360/${kind}?q=${encodeURIComponent(search)}`,
    fetcher,
    { keepPreviousData: true },
  )
  const detail = useSWR<View>(selected ? `/api/party-360/${kind}/${encodeURIComponent(selected)}` : null, fetcher)

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-balance">{title}</h1>
        <p className="text-sm text-muted-foreground text-pretty">{description}</p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="flex w-full flex-col gap-3 lg:w-72 lg:shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input
              aria-label={`Search ${kind}s`}
              placeholder="Search by name or code"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {list.error ? (
            <p className="text-sm text-destructive">{(list.error as Error).message}</p>
          ) : !list.data ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : list.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records found.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Records">
              {list.data.items.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => router.replace(`?id=${p.id}`, { scroll: false })}
                    aria-current={String(p.id) === selected ? "true" : undefined}
                    className="flex w-full flex-col rounded-md px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{[p.code, p.status].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col gap-4" aria-live="polite">
          {!selected ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Select a record to see its 360 view.
              </CardContent>
            </Card>
          ) : detail.error ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-destructive">{(detail.error as Error).message}</CardContent>
            </Card>
          ) : !detail.data ? (
            <Skeleton className="h-64" />
          ) : (
            <Detail view={detail.data} />
          )}
        </section>
      </div>
    </main>
  )
}

function Detail({ view }: { view: View }) {
  const masked = new Set(view.maskedFields)
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-xl">{view.name}</CardTitle>
            <div className="flex flex-wrap gap-2">
              {view.code && <Badge variant="secondary">{view.code}</Badge>}
              {view.scope === "self" && <Badge variant="outline">Your record</Badge>}
              {view.links.hasLoginAccount !== undefined && (
                <Badge variant="outline">{view.links.hasLoginAccount ? "Has login" : "No login"}</Badge>
              )}
            </div>
          </div>
          {view.scope === "full" && (
            <Link href={view.recordHref} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              Open record <ExternalLink className="size-3.5" aria-hidden />
            </Link>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(view.profile)
              .filter(([k]) => k !== "id")
              .map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                    {label(k)}
                    {masked.has(k) && <Lock className="size-3" aria-label="Masked" />}
                  </dt>
                  <dd className="truncate text-sm">{v == null || v === "" ? "—" : String(v)}</dd>
                </div>
              ))}
          </dl>
        </CardContent>
      </Card>

      {view.duplicates.length > 0 && (
        <Card className="border-amber-500/50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-amber-600" aria-hidden /> Possible duplicate records
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {view.duplicates.map((d) => (
                <li key={d.id}>
                  <Link href={d.href} className="text-primary hover:underline">{d.name}</Link>
                  <span className="text-muted-foreground"> · matched on {d.matchedOn.join(", ")}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {view.sections.map((s) => <SectionCard key={s.key} section={s} />)}
      </div>
    </>
  )
}

function SectionCard({ section }: { section: SectionResult }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">{section.label}</CardTitle>
        <div className="flex items-center gap-2">
          {section.status === "ok" && <Badge variant="secondary">{section.count}</Badge>}
          {section.status === "ok" && (
            <Link href={section.moduleHref} className="text-xs text-primary hover:underline">View all</Link>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {section.status !== "ok" ? (
          <p className="text-sm text-muted-foreground">{STATUS_COPY[section.status]}</p>
        ) : section.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {section.items.slice(0, 8).map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex min-w-0 flex-col">
                  <Link href={item.href} className="truncate font-medium hover:underline">{item.title}</Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {[item.subtitle, item.date?.slice(0, 10)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.amount != null && <span className="tabular-nums">{item.amount.toLocaleString()}</span>}
                  {item.status && <Badge variant="outline">{item.status}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
