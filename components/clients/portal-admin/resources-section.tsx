"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { CLIENTS, PERMISSION_LEVELS, SHARED_RESOURCES, type SharedResource } from "./data"
import { MoreHorizontal, Share2, Share } from "lucide-react"

export function ResourcesSection() {
  const [query, setQuery] = useState("")
  const [type, setType] = useState("all")
  const [shareOpen, setShareOpen] = useState(false)

  const types = useMemo(() => ["all", ...Array.from(new Set(SHARED_RESOURCES.map((r) => r.type)))], [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SHARED_RESOURCES.filter((r) => {
      if (type !== "all" && r.type !== type) return false
      if (!q) return true
      return [r.name, r.client, r.sharedWith].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, type])

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Shared Resources"
        description="Records and files shared with client portals — invoices, projects, documents, statements and more."
        actions={
          <Button size="sm" onClick={() => setShareOpen(true)}>
            <Share2 className="size-4" /> Share resource
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search resources…" className="w-full sm:w-72" />
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t} value={t}>{t === "all" ? "All types" : t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Share} title="No shared resources" description="Share invoices, documents or projects with a client to get started." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Shared with</TableHead>
                <TableHead>Permission</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r: SharedResource) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-xs text-muted-foreground">{r.type} · by {r.sharedBy} · {r.sharedDate}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{r.client}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.sharedWith}</TableCell>
                  <TableCell className="text-sm capitalize">{r.permission}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.expiry ?? "No expiry"}</TableCell>
                  <TableCell>
                    <StatusBadge label={r.status} tone={portalStatusTone(r.status)} className="capitalize" />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => toast.info("Edit sharing")}>Edit permission</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Expiry updated")}>Set expiry</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Access revoked")}>Revoke access</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share a resource</DialogTitle>
            <DialogDescription>Grant a client portal access to a record or file.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              toast.success("Resource shared")
              setShareOpen(false)
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="sr-name">Resource</Label>
              <Input id="sr-name" placeholder="e.g. INV-2026-0500" required />
            </div>
            <div className="grid gap-2">
              <Label>Client</Label>
              <Select defaultValue={CLIENTS[0].name}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENTS.map((c) => (
                    <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Permission</Label>
                <Select defaultValue="view">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_LEVELS.filter((l) => l.value !== "none").map((l) => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sr-expiry">Expiry (optional)</Label>
                <Input id="sr-expiry" type="date" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShareOpen(false)}>Cancel</Button>
              <Button type="submit">Share</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
