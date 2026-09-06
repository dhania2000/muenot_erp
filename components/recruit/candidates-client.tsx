"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Search, Users } from "lucide-react"
import { PageHeader, RatingStars } from "@/components/recruit/recruit-shared"
import { formatDate } from "@/lib/recruit"

type Candidate = {
  candidate_name: string
  email: string | null
  phone: string | null
  location: string | null
  current_company: string | null
  experience: string | null
  applications_count: number
  jobs: string | null
  rating: number
  last_applied: string
}

export function CandidatesClient() {
  const { data, isLoading } = useSWR<{ candidates: Candidate[] }>("/api/recruit/candidates", fetcher)
  const [search, setSearch] = useState("")
  const candidates = data?.candidates ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => [c.candidate_name, c.email, c.current_company, c.jobs].filter(Boolean).some((v) => v!.toLowerCase().includes(q)))
  }, [candidates, search])

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Candidate Database" description="Every person who has applied, aggregated across all your jobs." icon={Users} />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search candidates..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 pl-8" />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Current company</TableHead>
              <TableHead>Applied for</TableHead>
              <TableHead>Applications</TableHead>
              <TableHead>Rating</TableHead>
              <TableHead>Last applied</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">Loading candidates...</TableCell></TableRow>}
            {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No candidates yet.</TableCell></TableRow>}
            {filtered.map((c) => (
              <TableRow key={`${c.candidate_name}-${c.email}`}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{c.candidate_name}</span>
                    <span className="text-xs text-muted-foreground">{c.location || "—"}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col text-sm text-muted-foreground">
                    <span>{c.email || "—"}</span>
                    <span className="text-xs">{c.phone || ""}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{c.current_company || "—"}</TableCell>
                <TableCell className="max-w-56 truncate text-muted-foreground" title={c.jobs || ""}>{c.jobs || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{c.applications_count}</TableCell>
                <TableCell><RatingStars value={c.rating} readOnly /></TableCell>
                <TableCell className="text-muted-foreground">{formatDate(c.last_applied)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  )
}
