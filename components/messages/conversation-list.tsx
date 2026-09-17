"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Building2, Megaphone, Pin, Users, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTime, initials, type Conversation } from "./types"

const TYPE_ICON = {
  direct: null,
  group: Users,
  department: Building2,
  management: Megaphone,
} as const

export function ConversationList({
  items,
  selectedId,
  onSelect,
}: {
  items: Conversation[]
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  if (!items.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <Users className="size-8 opacity-40" />
        <p>No conversations here yet.</p>
      </div>
    )

  return (
    <ul className="flex flex-col">
      {items.map((c) => {
        const Icon = TYPE_ICON[c.type]
        const preview = c.last_deleted
          ? "Message deleted"
          : c.last_message_type === "announcement"
            ? `Announcement: ${c.last_message || ""}`
            : c.last_message || "No messages yet"
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                "flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-muted/60",
                selectedId === c.id && "bg-muted",
              )}
            >
              <Avatar className="size-10 shrink-0">
                <AvatarFallback className={cn("text-xs", c.type !== "direct" && "bg-primary/15 text-primary")}>
                  {Icon ? <Icon className="size-4" /> : initials(c.title)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{c.title}</span>
                  {c.is_pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
                  {c.is_muted ? <VolumeX className="size-3 shrink-0 text-muted-foreground" /> : null}
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatTime(c.last_message_time)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className={cn("truncate text-xs text-muted-foreground", c.unread > 0 && "font-medium text-foreground")}>
                    {c.type !== "direct" && c.last_sender ? `${c.last_sender.split(" ")[0]}: ` : ""}
                    {preview}
                  </p>
                  {c.unread > 0 && (
                    <Badge className="ml-auto h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px]">
                      {c.unread > 99 ? "99+" : c.unread}
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
