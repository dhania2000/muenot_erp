"use client"

import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Search } from "lucide-react"
import { api, initials, type Recipient } from "./types"

type Meta = {
  users: Recipient[]
  departments: string[]
  myDepartment: string | null
  canCreateGroup: boolean
  canCreateManagement: boolean
}

export function NewConversationDialog({
  open,
  onOpenChange,
  meta,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  meta: Meta
  onCreated: (id: number) => void
}) {
  const [tab, setTab] = useState<"direct" | "group" | "department" | "management">("direct")
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [groupName, setGroupName] = useState("")
  const [groupDesc, setGroupDesc] = useState("")
  const [department, setDepartment] = useState(meta.myDepartment || meta.departments[0] || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return meta.users
    return meta.users.filter(
      (u) =>
        u.name.toLowerCase().includes(n) ||
        (u.department || "").toLowerCase().includes(n) ||
        (u.designation || "").toLowerCase().includes(n),
    )
  }, [q, meta.users])

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function reset() {
    setSelected(new Set())
    setGroupName("")
    setGroupDesc("")
    setQ("")
    setError("")
  }

  async function submit() {
    setError("")
    setBusy(true)
    try {
      let payload: any
      if (tab === "direct") {
        const recipientId = [...selected][0]
        if (!recipientId) throw new Error("Select a person to message")
        payload = { type: "direct", recipientId }
      } else if (tab === "group") {
        if (groupName.trim().length < 2) throw new Error("Enter a group name")
        if (!selected.size) throw new Error("Select at least one member")
        payload = { type: "group", name: groupName, description: groupDesc, memberIds: [...selected] }
      } else if (tab === "department") {
        payload = { type: "department", department }
      } else {
        payload = { type: "management", name: groupName || "Management", memberIds: [...selected] }
      }
      const res = await api<{ id: number }>("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      reset()
      onOpenChange(false)
      onCreated(res.id)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const showPicker = tab === "direct" || tab === "group" || tab === "management"

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => { setTab(v as any); setSelected(new Set()) }}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="direct">Direct</TabsTrigger>
            {meta.canCreateGroup && <TabsTrigger value="group">Group</TabsTrigger>}
            <TabsTrigger value="department">Dept</TabsTrigger>
            {meta.canCreateManagement && <TabsTrigger value="management">Mgmt</TabsTrigger>}
          </TabsList>
        </Tabs>

        {tab === "group" && (
          <div className="grid gap-2">
            <Label htmlFor="gname">Group name</Label>
            <Input id="gname" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Project Falcon" />
            <Textarea value={groupDesc} onChange={(e) => setGroupDesc(e.target.value)} placeholder="Description (optional)" rows={2} />
          </div>
        )}

        {tab === "management" && (
          <div className="grid gap-2">
            <Label htmlFor="mname">Title</Label>
            <Input id="mname" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Management" />
            <p className="text-xs text-muted-foreground">All management users are added automatically. Add extra people below.</p>
          </div>
        )}

        {tab === "department" && (
          <div className="grid gap-2">
            <Label>Department</Label>
            {meta.departments.length ? (
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              >
                {meta.departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-muted-foreground">No department is available on your HR record.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Members are synced automatically from the HR Employee Master.
            </p>
          </div>
        )}

        {showPicker && (
          <div className="grid gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-9" />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              {filtered.length ? (
                filtered.map((u) => {
                  const checked = selected.has(u.id)
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => (tab === "direct" ? setSelected(new Set([u.id])) : toggle(u.id))}
                      className={`flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted ${
                        checked ? "bg-primary/10" : ""
                      }`}
                    >
                      {tab !== "direct" && <Checkbox checked={checked} className="pointer-events-none" />}
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs">{initials(u.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{u.name}</span>
                          {u.role === "admin" && <Badge variant="secondary" className="text-[10px]">Management</Badge>}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {[u.designation, u.department].filter(Boolean).join(" · ") || u.email}
                        </p>
                      </div>
                    </button>
                  )
                })
              ) : (
                <p className="p-6 text-center text-sm text-muted-foreground">No matching people.</p>
              )}
            </div>
            {tab !== "direct" && <p className="text-xs text-muted-foreground">{selected.size} selected</p>}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Creating..." : "Start"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
