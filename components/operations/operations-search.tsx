"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Search, ArrowRight } from "lucide-react"

type SearchHit = {
  id: string | number
  title: string
  subtitle: string
  meta: string
}

type Group = {
  key: string
  label: string
  href: string
  results: SearchHit[]
}

type SearchResponse = {
  query: string
  total?: number
  groups: Group[]
}

// Debounce the raw input so we only hit the API when typing settles.
function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function OperationsSearch() {
  const [term, setTerm] = useState("")
  const debounced = useDebounced(term.trim(), 300)
  const shouldSearch = debounced.length >= 2

  const { data, isLoading } = useSWR<SearchResponse>(
    shouldSearch ? `/api/operations/search?q=${encodeURIComponent(debounced)}` : null,
    fetcher,
    { keepPreviousData: true },
  )

  const groups = useMemo(() => data?.groups ?? [], [data])
  const total = data?.total ?? groups.reduce((sum, g) => sum + g.results.length, 0)

  return (
    <main className="space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">Delivery cockpit</p>
        <h1 className="text-3xl font-semibold tracking-tight">Operations Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search across projects, clients, tasks, issues, deliverables, employees and reference IDs.
        </p>
      </div>

      <div className="relative max-w-2xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by project, client, task, issue, deliverable, employee or reference ID..."
          className="pl-9"
          aria-label="Operations search"
        />
      </div>

      {!shouldSearch && (
        <p className="text-sm text-muted-foreground">Type at least 2 characters to search.</p>
      )}

      {shouldSearch && isLoading && !data && (
        <p className="text-sm text-muted-foreground">Searching...</p>
      )}

      {shouldSearch && data && total === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No matches for &quot;{debounced}&quot;.
          </CardContent>
        </Card>
      )}

      {shouldSearch && total > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <Card key={group.key}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{group.label}</CardTitle>
                <Badge variant="outline">{group.results.length}</Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 p-2">
                {group.results.map((hit) => (
                  <Link
                    key={String(hit.id)}
                    href={group.href}
                    className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{hit.title}</p>
                      {hit.subtitle && (
                        <p className="truncate text-xs text-muted-foreground">{hit.subtitle}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {hit.meta && <Badge variant="outline">{hit.meta}</Badge>}
                      <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}
