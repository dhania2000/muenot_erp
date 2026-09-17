"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MessageSquarePlus, Search } from "lucide-react"
import { ConversationList } from "@/components/messages/conversation-list"
import { ChatView } from "@/components/messages/chat-view"
import { NewConversationDialog } from "@/components/messages/new-conversation-dialog"
import { ManageGroupSheet } from "@/components/messages/manage-group-sheet"
import { api, type Conversation, type ConversationDetail, type Recipient } from "@/components/messages/types"

type Meta = {
  users: Recipient[]
  departments: string[]
  myDepartment: string | null
  canCreateGroup: boolean
  canCreateManagement: boolean
  canAnnounce: boolean
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "direct", label: "Direct" },
  { key: "group", label: "Groups" },
  { key: "department", label: "Departments" },
  { key: "important", label: "Important" },
] as const

export function MessagesClient() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [filter, setFilter] = useState<string>("all")
  const [showArchived, setShowArchived] = useState(false)
  const [q, setQ] = useState("")
  const [compose, setCompose] = useState(false)
  const [manage, setManage] = useState<ConversationDetail | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams({ filter })
    if (showArchived) params.set("archived", "1")
    if (q.trim()) params.set("q", q.trim())
    try {
      const data = await api<{ conversations: Conversation[] }>(`/api/messages?${params}`)
      setConversations(data.conversations)
    } catch {
      /* handled by empty state */
    }
  }, [filter, showArchived, q])

  useEffect(() => {
    api<Meta>("/api/messages/recipients").then(setMeta).catch(() => {})
  }, [])

  useEffect(() => {
    loadConversations()
    const t = setInterval(loadConversations, 10000)
    return () => clearInterval(t)
  }, [loadConversations])

  const unreadTotal = conversations.reduce((n, c) => n + (c.unread || 0), 0)

  return (
    <main className="flex h-[calc(100vh-4rem)] flex-col gap-4 p-4 md:p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
          <p className="text-sm text-muted-foreground">
            Employee communication{unreadTotal > 0 ? ` · ${unreadTotal} unread` : ""}
          </p>
        </div>
        <Button onClick={() => setCompose(true)}>
          <MessageSquarePlus className="mr-2 size-4" /> New
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-card lg:grid-cols-[340px_1fr]">
        {/* Sidebar */}
        <aside
          className={cn(
            "flex min-h-0 flex-col border-r",
            selected !== null && "hidden lg:flex",
          )}
        >
          <div className="border-b p-3">
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" className="pl-9" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => { setFilter(f.key); setShowArchived(false) }}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs transition-colors",
                    filter === f.key && !showArchived
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70",
                  )}
                >
                  {f.label}
                </button>
              ))}
              <button
                onClick={() => { setShowArchived((v) => !v); setFilter("all") }}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs transition-colors",
                  showArchived ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                )}
              >
                Archived
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList items={conversations} selectedId={selected} onSelect={setSelected} />
          </div>
        </aside>

        {/* Main */}
        <section className={cn("min-h-0", selected === null && "hidden lg:block")}>
          {selected !== null ? (
            <ChatView
              key={selected}
              conversationId={selected}
              onBack={() => setSelected(null)}
              onChanged={loadConversations}
              onManage={(d) => { setManage(d); setManageOpen(true) }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <MessageSquarePlus className="size-10 opacity-40" />
              <p className="max-w-xs text-sm">
                Select a conversation to start messaging, or create a new direct, group, or department chat.
              </p>
              <Button variant="outline" onClick={() => setCompose(true)}>New conversation</Button>
            </div>
          )}
        </section>
      </div>

      {meta && (
        <NewConversationDialog
          open={compose}
          onOpenChange={setCompose}
          meta={meta}
          onCreated={(id) => { setSelected(id); loadConversations() }}
        />
      )}

      <ManageGroupSheet
        detail={manage}
        directory={meta?.users || []}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onChanged={loadConversations}
      />
    </main>
  )
}
