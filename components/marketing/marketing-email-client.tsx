"use client"

import { useMemo, useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Mail, ListFilter, Search, MoreVertical, FileText, CheckCircle2, Clock, Send, Trash2 } from "lucide-react"

type Status = "Draft" | "Sent" | "Scheduled" | "Sending"

type EmailCampaign = {
  id: string
  name: string
  createdAt: string
  folder: string
  status: Status
  opened: number | null
  clicked: number | null
}

const STATUS_META: Record<Status, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
  Draft: { label: "Draft", icon: FileText, className: "text-primary" },
  Sent: { label: "Sent", icon: CheckCircle2, className: "text-emerald-600" },
  Scheduled: { label: "Scheduled", icon: Clock, className: "text-amber-600" },
  Sending: { label: "Sending", icon: Send, className: "text-primary" },
}

const SEED: EmailCampaign[] = []

const FOLDERS = ["All Folders", "General", "Newsletters", "Promotions", "Automated"]

function formatNow() {
  return new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function MarketingEmailClient() {
  const [rows, setRows] = useState<EmailCampaign[]>(SEED)
  const [folder, setFolder] = useState("All Folders")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: "", folder: "General" })

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const matchFolder = folder === "All Folders" || r.folder === folder
      const matchQuery = r.name.toLowerCase().includes(query.trim().toLowerCase())
      return matchFolder && matchQuery
    })
  }, [rows, folder, query])

  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.id))

  function toggleAll() {
    setSelected((prev) => {
      if (allChecked) {
        const next = new Set(prev)
        filtered.forEach((r) => next.delete(r.id))
        return next
      }
      return new Set([...prev, ...filtered.map((r) => r.id)])
    })
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function create() {
    if (!form.name.trim()) return
    setRows((prev) => [
      {
        id: `EML-${100 + prev.length + 1}`,
        name: form.name.trim(),
        createdAt: formatNow(),
        folder: form.folder,
        status: "Draft",
        opened: null,
        clicked: null,
      },
      ...prev,
    ])
    setForm({ name: "", folder: "General" })
    setOpen(false)
  }

  function remove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const count = filtered.length

  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-muted/40">
            <Mail className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">Marketing Campaigns</p>
            <h1 className="text-2xl font-semibold uppercase tracking-tight">Email Campaigns</h1>
          </div>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="lg">Create</Button>} />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Email Campaign</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name" className="text-xs text-muted-foreground">
                  Campaign name
                </Label>
                <Input
                  id="name"
                  placeholder="e.g. Weekly Newsletter"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Folder</Label>
                <Select value={form.folder} onValueChange={(v) => setForm({ ...form, folder: v ?? "General" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOLDERS.filter((f) => f !== "All Folders").map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancel</Button>} />
              <Button onClick={create}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <p className="text-lg">
            <span className="font-semibold">{count}</span>{" "}
            <span className="text-muted-foreground">
              Email {count === 1 ? "Campaign" : "Campaigns"} in this list
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={folder} onValueChange={(v) => setFolder(v ?? "All Folders")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOLDERS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" aria-label="Filter campaigns">
              <ListFilter className="size-4" />
            </Button>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="I'm Searching for campaign"
                className="w-56 pl-9"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-12 px-4 py-3">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all campaigns" />
                </th>
                <th className="px-2 py-3 font-medium">Email Campaigns Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Opened</th>
                <th className="px-4 py-3 text-right font-medium">Clicked</th>
                <th className="w-12 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                    No email campaigns found.
                  </td>
                </tr>
              ) : (
                filtered.map((c) => {
                  const meta = STATUS_META[c.status]
                  const StatusIcon = meta.icon
                  return (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-4">
                        <Checkbox
                          checked={selected.has(c.id)}
                          onCheckedChange={() => toggleOne(c.id)}
                          aria-label={`Select ${c.name}`}
                        />
                      </td>
                      <td className="px-2 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-full border">
                            <Mail className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{c.name}</div>
                            <div className="truncate text-xs text-muted-foreground">Created on {c.createdAt}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center gap-1.5 font-medium ${meta.className}`}>
                          <StatusIcon className="size-4" />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums text-muted-foreground">
                        {c.opened == null ? "-" : `${c.opened}%`}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums text-muted-foreground">
                        {c.clicked == null ? "-" : `${c.clicked}%`}
                      </td>
                      <td className="px-4 py-4">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                                <MoreVertical className="size-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>Edit</DropdownMenuItem>
                            <DropdownMenuItem>Duplicate</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => remove(c.id)}>
                              <Trash2 className="size-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  )
}
