"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FileText, MoreHorizontal, Plus, Search } from "lucide-react"
import { PageHeader, StatusPill } from "@/components/recruit/recruit-shared"
import { OFFER_STATUSES, formatDate, formatMoney } from "@/lib/recruit"

type Offer = {
  offer_id: string
  candidate_name: string | null
  job_title: string | null
  salary: number | null
  currency: string
  joining_date: string | null
  expiry_date: string | null
  status: string
  content: string | null
}

export function OffersClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ offers: Offer[] }>("/api/recruit/offers", fetcher)
  const [search, setSearch] = useState("")
  const [preview, setPreview] = useState<Offer | null>(null)
  const offers = data?.offers ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return offers
    return offers.filter((o) => [o.candidate_name, o.job_title].filter(Boolean).some((v) => v!.toLowerCase().includes(q)))
  }, [offers, search])

  async function updateStatus(o: Offer, status: string) {
    const res = await fetch(`/api/recruit/offers/${o.offer_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...o, status }),
    })
    if (res.ok) { toast.success("Offer updated"); mutate() } else toast.error("Unable to update")
  }

  async function remove(id: string) {
    if (!confirm("Delete this offer letter?")) return
    const res = await fetch(`/api/recruit/offers/${id}`, { method: "DELETE" })
    if (res.ok) { toast.success("Offer deleted"); mutate() } else toast.error("Unable to delete")
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Job Offer Letter"
        description="Draft, send and track offer letters for selected candidates."
        icon={FileText}
        action={canManage ? (
          <Button render={<Link href="/modules/recruitment/job-offer-letter/create" />}>
            <Plus data-icon="inline-start" /> Create Offer
          </Button>
        ) : undefined}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search offers..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 pl-8" />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate</TableHead>
              <TableHead>Job</TableHead>
              <TableHead>Salary</TableHead>
              <TableHead>Joining</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">Loading offers...</TableCell></TableRow>}
            {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No offer letters yet.</TableCell></TableRow>}
            {filtered.map((o) => (
              <TableRow key={o.offer_id}>
                <TableCell className="font-medium">{o.candidate_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{o.job_title || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatMoney(o.salary, o.currency)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(o.joining_date)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(o.expiry_date)}</TableCell>
                <TableCell><StatusPill status={o.status} kind="offer" /></TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setPreview(o)}>View letter</DropdownMenuItem>
                      {canManage && OFFER_STATUSES.map((s) => (
                        <DropdownMenuItem key={s.value} onClick={() => updateStatus(o, s.value)}>Mark {s.label}</DropdownMenuItem>
                      ))}
                      {canManage && <DropdownMenuItem variant="destructive" onClick={() => remove(o.offer_id)}>Delete</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>Offer letter — {preview.candidate_name}</DialogTitle>
                <DialogDescription>{preview.job_title || "—"} · {preview.offer_id}</DialogDescription>
              </DialogHeader>
              <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 text-sm leading-relaxed">
                {preview.content || "No letter content."}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
