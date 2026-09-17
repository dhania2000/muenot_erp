"use client"

import { useMemo, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Checkbox } from "@/components/ui/checkbox"
import { Crown, Search, ShieldOff, UserMinus, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { api, initials, type ConversationDetail, type Recipient } from "./types"

export function ManageGroupSheet({
  detail,
  directory,
  open,
  onOpenChange,
  onChanged,
}: {
  detail: ConversationDetail | null
  directory: Recipient[]
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState("")
  const [toAdd, setToAdd] = useState<Set<number>>(new Set())
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")

  const canManage = detail?.myRole === "admin"
  const memberIds = useMemo(
    () => new Set(detail?.participants.filter((p) => p.active).map((p) => p.user_id)),
    [detail],
  )
  const candidates = useMemo(
    () => directory.filter((u) => !memberIds.has(u.id) && u.name.toLowerCase().includes(q.trim().toLowerCase())),
    [directory, memberIds, q],
  )

  if (!detail) return null
  const conv = detail.conversation

  async function act(action: string, payload: any) {
    try {
      await api(`/api/messages/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      })
      onChanged()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{canManage ? "Manage" : "About"} · {conv.title}</SheetTitle>
        </SheetHeader>

        {conv.type === "department" && (
          <Badge variant="secondary" className="w-fit">Department channel · synced from HR</Badge>
        )}
        {conv.description && <p className="text-sm text-muted-foreground">{conv.description}</p>}

        {canManage && conv.type === "group" && (
          <div className="grid gap-2 rounded-lg border p-3">
            <Input placeholder="Group name" defaultValue={conv.name || ""} onChange={(e) => setName(e.target.value)} />
            <Textarea placeholder="Description" defaultValue={conv.description || ""} rows={2} onChange={(e) => setDesc(e.target.value)} />
            <Button
              size="sm"
              className="w-fit"
              onClick={() => act("updateInfo", { name: name || conv.name, description: desc })}
            >
              Save details
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{memberIds.size} members</h3>
          {canManage && conv.type !== "department" && (
            <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
              <UserPlus className="mr-1.5 size-4" /> Add
            </Button>
          )}
        </div>

        {adding && (
          <div className="grid gap-2 rounded-lg border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-9" />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {candidates.map((u) => (
                <label key={u.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <Checkbox
                    checked={toAdd.has(u.id)}
                    onCheckedChange={() =>
                      setToAdd((prev) => {
                        const next = new Set(prev)
                        next.has(u.id) ? next.delete(u.id) : next.add(u.id)
                        return next
                      })
                    }
                  />
                  {u.name}
                  <span className="text-xs text-muted-foreground">{u.designation}</span>
                </label>
              ))}
              {!candidates.length && <p className="py-3 text-center text-xs text-muted-foreground">No one to add.</p>}
            </div>
            <Button
              size="sm"
              disabled={!toAdd.size}
              onClick={async () => {
                await act("addMembers", { memberIds: [...toAdd] })
                setToAdd(new Set())
                setAdding(false)
              }}
            >
              Add {toAdd.size || ""} member{toAdd.size === 1 ? "" : "s"}
            </Button>
          </div>
        )}

        <Separator />

        <ul className="flex flex-col gap-1">
          {detail.participants
            .filter((p) => p.active)
            .map((p) => (
              <li key={p.user_id} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                <Avatar className="size-9">
                  <AvatarFallback className="text-xs">{initials(p.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {p.role === "admin" && <Crown className="size-3.5 text-amber-500" />}
                    {p.user_role === "admin" && <Badge variant="secondary" className="text-[10px]">Mgmt</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[p.designation, p.department].filter(Boolean).join(" · ") || p.email}
                  </p>
                </div>
                {canManage && conv.type !== "department" && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={p.role === "admin" ? "Demote" : "Make admin"}
                      onClick={() => act("setRole", { userId: p.user_id, role: p.role === "admin" ? "member" : "admin" })}
                    >
                      {p.role === "admin" ? <ShieldOff className="size-4" /> : <Crown className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove member"
                      onClick={() => act("removeMembers", { memberIds: [p.user_id] })}
                    >
                      <UserMinus className="size-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
        </ul>
      </SheetContent>
    </Sheet>
  )
}
