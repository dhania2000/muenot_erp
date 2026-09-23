"use client"

import { useState } from "react"
import useSWR from "swr"
import { Plus, ShieldAlert, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { fetcher } from "@/lib/fetcher"
import type { LegalHold, LegalHoldCatalogItem } from "./legal-hold-types"
import {
  LegalHoldItemFields,
  emptyItemDraft,
  itemDraftToPayload,
  validateItemDraft,
  type ItemDraft,
} from "./legal-hold-item-fields"

const API = "/api/admin/governance/legal-holds"

type DetailResponse = { hold: LegalHold }

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

export function LegalHoldDetail({
  holdId,
  open,
  onOpenChange,
  onChanged,
  catalog,
}: {
  holdId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  catalog: LegalHoldCatalogItem[]
}) {
  const key = holdId != null && open ? `${API}/${holdId}` : null
  const { data, isLoading, mutate } = useSWR<DetailResponse>(key, fetcher)
  const hold = data?.hold ?? null

  const [draft, setDraft] = useState<ItemDraft>(emptyItemDraft())
  const [busy, setBusy] = useState(false)

  function refreshAll() {
    mutate()
    onChanged()
  }

  async function addItem() {
    if (!hold) return
    const err = validateItemDraft(draft)
    if (err) {
      toast.error(err)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${API}/${hold.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(itemDraftToPayload(draft)),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not add item")
      }
      toast.success("Coverage item added.")
      setDraft(emptyItemDraft())
      refreshAll()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeItem(itemId: number) {
    if (!hold) return
    try {
      const res = await fetch(`${API}/${hold.id}/items/${itemId}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not remove item")
      }
      toast.success("Coverage item removed.")
      refreshAll()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const active = hold?.status === "active"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2">{hold ? hold.name : "Legal hold"}</SheetTitle>
          <SheetDescription>
            {hold
              ? "Everything this hold covers is protected from automated retention archive/delete until the hold is released."
              : "Manage the records and files this hold protects."}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !hold ? (
          <div className="space-y-3 p-1 pt-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={active ? "destructive" : "secondary"} className="capitalize">
                {hold.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Created by {hold.createdByName ?? "—"} · {formatDateTime(hold.createdAt)}
              </span>
            </div>

            {hold.reason && (
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">{hold.reason}</div>
            )}

            {!active && hold.releasedReason && (
              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                Released by {hold.releasedByName ?? "—"} on {formatDateTime(hold.releasedAt)} — {hold.releasedReason}
              </div>
            )}

            <Separator />

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Coverage ({hold.items?.length ?? 0})</h3>
              </div>

              {(hold.items?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  This hold covers nothing yet. Add at least one item so retention jobs know what to protect.
                </p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Scope</TableHead>
                        <TableHead>Covers</TableHead>
                        {active && <TableHead className="w-10" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hold.items!.map((it) => (
                        <TableRow key={it.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {it.scope.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{it.label}</TableCell>
                          {active && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label="Remove item"
                                onClick={() => removeItem(it.id)}
                              >
                                <Trash2 className="size-3.5 text-destructive" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {active && (
                <div className="grid gap-3 rounded-md border p-3">
                  <LegalHoldItemFields draft={draft} onChange={setDraft} catalog={catalog} />
                  <Button size="sm" variant="outline" className="w-fit gap-1.5" onClick={addItem} disabled={busy}>
                    <Plus className="size-3.5" />
                    Add coverage item
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
