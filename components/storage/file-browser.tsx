"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { FileText, Loader2, Search, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"
import { FileDetailDrawer, type BrowserFile } from "@/components/storage/file-detail-drawer"
import { formatBytes } from "@/lib/storage/format"

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

const CLASSIFICATION_TONE: Record<string, string> = {
  public: "border-transparent bg-muted text-foreground",
  internal: "border-transparent bg-blue-600 text-white",
  confidential: "border-transparent bg-amber-600 text-white",
  restricted: "border-transparent bg-destructive text-white",
}

function SafetyBadge({ safety }: { safety: string }) {
  if (safety === "safe")
    return (
      <Badge className="gap-1 border-transparent bg-emerald-600 text-white">
        <ShieldCheck className="size-3" /> Safe
      </Badge>
    )
  if (safety === "unsafe")
    return (
      <Badge className="gap-1 border-transparent bg-destructive text-white">
        <ShieldAlert className="size-3" /> Unsafe
      </Badge>
    )
  return (
    <Badge variant="outline" className="gap-1">
      <ShieldQuestion className="size-3" /> Unknown
    </Badge>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const PAGE_SIZE = 20

/**
 * File browsing. Table over the tenant's centralized file metadata
 * (module, owner, provider, type, size, version, security state,
 * classification, uploader, updated date) with search, module filter and
 * pagination. Clicking a row opens the File Detail drawer.
 */
export function FileBrowser() {
  const { data, isLoading, error, mutate } = useSWR<{ files: BrowserFile[] }>(
    "/api/admin/storage/files",
    fetcher,
    { revalidateOnFocus: false },
  )
  const files = data?.files ?? []

  const [search, setSearch] = useState("")
  const [moduleFilter, setModuleFilter] = useState<string>("all")
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<BrowserFile | null>(null)

  const modules = useMemo(() => Array.from(new Set(files.map((f) => f.module))).sort(), [files])

  const filtered = useMemo(() => {
    return files.filter((f) => {
      if (moduleFilter !== "all" && f.module !== moduleFilter) return false
      if (search && !`${f.filename ?? ""} ${f.fileRef}`.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [files, moduleFilter, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="size-5 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Files</CardTitle>
        </div>
        <CardDescription>
          Every file tracked in the centralized metadata store, across every module. Click a row to open its
          detail, versions, security and retention information.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or file ID…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              className="pl-8"
            />
          </div>
          <Select
            value={moduleFilter}
            onValueChange={(v) => {
              setModuleFilter(v ?? "all")
              setPage(0)
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Module" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modules</SelectItem>
              {modules.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-sm text-muted-foreground">{filtered.length} file(s)</span>
        </div>

        {error && <p className="text-sm text-destructive">Could not load files.</p>}

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading files…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title="No files found">
            {files.length === 0
              ? "No files have been uploaded yet. Files uploaded across any module appear here automatically."
              : "No files match the current search or filter."}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File name</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Security</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((f) => (
                    <TableRow
                      key={f.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(f)}
                      tabIndex={0}
                      role="button"
                      onKeyDown={(e) => e.key === "Enter" && setSelected(f)}
                    >
                      <TableCell className="max-w-[220px] truncate font-medium">{f.filename || f.fileRef}</TableCell>
                      <TableCell className="text-muted-foreground">{f.module}</TableCell>
                      <TableCell className="text-muted-foreground">{f.ownerName || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{f.provider}</TableCell>
                      <TableCell className="text-muted-foreground">{f.mimeType || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatBytes(f.size)}</TableCell>
                      <TableCell>v{f.version}</TableCell>
                      <TableCell>
                        <SafetyBadge safety={f.safety} />
                      </TableCell>
                      <TableCell>
                        <Badge className={CLASSIFICATION_TONE[f.classification] ?? ""}>{f.classification}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(f.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 disabled:opacity-40"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 disabled:opacity-40"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <FileDetailDrawer file={selected} onClose={() => setSelected(null)} onChanged={() => mutate()} />
    </Card>
  )
}
