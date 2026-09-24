"use client"

import { useEffect, useRef, useState } from "react"
import type { VendorPortalMessage } from "@/lib/vendor-portal/store"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Loader2, Send } from "lucide-react"

function formatTime(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function MessagesView({
  initialMessages,
}: {
  initialMessages: VendorPortalMessage[]
}) {
  const [messages, setMessages] = useState(initialMessages)
  const [body, setBody] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length])

  async function send() {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch("/api/vendor-portal/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not send message")
        return
      }
      setMessages((prev) => [...prev, data.message])
      setBody("")
    } catch {
      setError("Could not send message")
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
        <p className="text-sm text-muted-foreground">Direct messages with the accounts-payable team.</p>
      </div>

      <div className="flex min-h-[50vh] flex-col rounded-lg border border-border bg-background">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No messages yet. Start the conversation below.
            </p>
          ) : (
            messages.map((m) => {
              const mine = m.author_type === "vendor"
              return (
                <div key={m.id} className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                      mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                  <span className="mt-1 px-1 text-xs text-muted-foreground">
                    {mine ? "You" : m.author_name} · {formatTime(m.created_at)}
                  </span>
                </div>
              )
            })
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-border p-3">
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
          <div className="flex items-end gap-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type a message…"
              rows={1}
              className="max-h-32 min-h-10 resize-none"
              aria-label="Message"
            />
            <Button onClick={send} disabled={sending || !body.trim()} size="icon" aria-label="Send message">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
