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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState, KpiCard, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { DOCUMENT_CATEGORIES, DOCUMENTS } from "./data"
import { FileText, MoreHorizontal, Upload } from "lucide-react"

export function DocumentsSection() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [visibility, setVisibility] = useState("all")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return DOCUMENTS.filter((d) => {
      if (category !== "all" && d.category !== category) return false
      if (visibility !== "all" && d.visibility !== visibility) return false
      if (!q) return true
      return [d.name, d.client, d.uploadedBy].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, category, visibility])

  const pending = DOCUMENTS.filter((d) => d.verification === "pending").length
  const rejected = DOCUMENTS.filter((d) => d.verification === "rejected").length

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Document Center"
        description="Every document shared through or uploaded to the client portal, organised by category."
        actions={
          <Button size="sm" onClick={() => toast.success("Upload dialog opened")}>
            <Upload className="size-4" /> Upload document
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total documents" value={DOCUMENTS.length} />
        <KpiCard label="Awaiting review" value={pending} tone="warning" />
        <KpiCard label="Rejected" value={rejected} tone="danger" />
        <KpiCard label="Categories" value={DOCUMENT_CATEGORIES.length} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search documents…" className="w-full sm:w-72" />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {DOCUMENT_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={visibility} onValueChange={setVisibility}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All visibility</SelectItem>
            <SelectItem value="shared">Shared</SelectItem>
            <SelectItem value="internal">Internal</SelectItem>
            <SelectItem value="private">Private</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={FileText} title="No documents" description="Upload or share a document to populate the document center." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <FileText className="size-4" />
                      </span>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{d.name}</span>
                        <span className="text-xs text-muted-foreground">{d.uploadedBy} · {d.uploadedDate}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{d.category}</TableCell>
                  <TableCell className="text-sm">{d.client}</TableCell>
                  <TableCell className="text-sm capitalize">{d.visibility}</TableCell>
                  <TableCell>
                    <StatusBadge label={d.verification} tone={portalStatusTone(d.verification)} className="capitalize" />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => toast.success("Downloading")}>Download</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Marked verified")}>Mark verified</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.info("Visibility changed")}>Change visibility</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => toast.success("Document removed")}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
