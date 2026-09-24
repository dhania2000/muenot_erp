"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { GitMerge, Search } from "lucide-react"
import type { ContactRow } from "@/components/contacts/contact-dialog"

export function MergeDialog({
  survivor,
  open,
  onOpenChange,
  onMerged,
}: {
  survivor: ContactRow
  open: boolean
  onOpenChange: (v: boolean) => void
  onMerged: () => void
}) {
  const [q, setQ] = useState("")
  const [loserId, setLoserId] = useState<number | null>(null)
  const [merging, setMerging] = useState(false)

  const { data } = useSWR<{ contacts: ContactRow[] }>(
    q.trim() ? `/api/contacts?q=${encodeURIComponent(q.trim())}` : null,
    fetcher,
  )
  const candidates = (data?.contacts ?? []).filter((c) => c.id !== survivor.id)

  async function doMerge() {
    if (!loserId) return
    setMerging(true)
    const res = await fetch(`/api/contacts/${survivor.id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loserId }),
    })
    setMerging(false)
    if (res.ok) {
      toast.success("Contacts merged")
      onMerged()
    } else {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || "Unable to merge")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4" /> Merge into {survivor.full_name}
          </DialogTitle>
          <DialogDescription>
            Pick the duplicate to merge. It will be archived and its CRM, Finance, Sales and Marketing links re-pointed to{" "}
            {survivor.full_name}.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search duplicate contact…" className="pl-8" />
        </div>

        <div className="grid max-h-64 gap-2 overflow-y-auto">
          {!q.trim() ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Search for the duplicate contact to merge.</p>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching contacts.</p>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setLoserId(c.id)}
                className={
                  "rounded-md border p-2 text-left text-sm transition-colors " +
                  (loserId === c.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")
                }
              >
                <div className="font-medium">{c.full_name}</div>
                <div className="text-xs text-muted-foreground">
                  {[c.contact_code, c.company_name, c.email, c.phone].filter(Boolean).join(" · ")}
                </div>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!loserId || merging} onClick={doMerge}>
            {merging ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
