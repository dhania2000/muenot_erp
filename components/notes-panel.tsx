"use client"

import { useState } from "react"
import useSWR from "swr"
import { Check, Loader2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Note = {
  id: number
  content: string
  color: NoteColor
  completed: boolean
  created_at: string
  updated_at: string
}

type NoteColor = "default" | "amber" | "emerald" | "sky" | "rose"

const COLORS: NoteColor[] = ["default", "amber", "emerald", "sky", "rose"]

// Subtle tints keep the Keep-style colored cards readable in the dark theme.
const CARD_STYLES: Record<NoteColor, string> = {
  default: "bg-card border-border",
  amber: "bg-amber-500/10 border-amber-500/30",
  emerald: "bg-emerald-500/10 border-emerald-500/30",
  sky: "bg-sky-500/10 border-sky-500/30",
  rose: "bg-rose-500/10 border-rose-500/30",
}

const SWATCH_STYLES: Record<NoteColor, string> = {
  default: "bg-muted-foreground/40",
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  rose: "bg-rose-500",
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function ColorPicker({
  value,
  onChange,
}: {
  value: NoteColor
  onChange: (c: NoteColor) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Color ${c}`}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
          className={cn(
            "size-5 rounded-full border transition-transform hover:scale-110",
            SWATCH_STYLES[c],
            value === c ? "border-foreground ring-2 ring-foreground/30" : "border-border",
          )}
        />
      ))}
    </div>
  )
}

function NoteCard({
  note,
  onChanged,
}: {
  note: Note
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.content)
  const [busy, setBusy] = useState(false)

  async function patch(payload: Record<string, unknown>) {
    setBusy(true)
    try {
      await fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await fetch(`/api/notes/${note.id}`, { method: "DELETE" })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    const content = draft.trim()
    if (!content) return
    await patch({ content })
    setEditing(false)
  }

  return (
    <div className={cn("group flex flex-col gap-2 rounded-xl border p-3 transition-colors", CARD_STYLES[note.color])}>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={note.completed}
          onCheckedChange={(checked) => patch({ completed: Boolean(checked) })}
          disabled={busy}
          className="mt-0.5"
          aria-label={note.completed ? "Mark as not done" : "Mark as done"}
        />
        {editing ? (
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="min-h-16 flex-1 resize-none bg-background/60"
          />
        ) : (
          <p
            className={cn(
              "flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed",
              note.completed && "text-muted-foreground line-through",
            )}
          >
            {note.content}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <ColorPicker value={note.color} onChange={(color) => patch({ color })} />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {new Date(note.updated_at.replace(" ", "T")).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
            })}
          </span>
        )}

        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button size="icon-sm" variant="ghost" onClick={saveEdit} disabled={busy} aria-label="Save note">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  setDraft(note.content)
                  setEditing(false)
                }}
                aria-label="Cancel edit"
              >
                <X className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => setEditing(true)}
                aria-label="Edit note"
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={remove}
                disabled={busy}
                aria-label="Delete note"
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function NotesPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, mutate, isLoading } = useSWR<{ notes: Note[] }>(open ? "/api/notes" : null, fetcher)
  const [content, setContent] = useState("")
  const [color, setColor] = useState<NoteColor>("default")
  const [adding, setAdding] = useState(false)

  const notes = data?.notes ?? []
  const active = notes.filter((n) => !n.completed)
  const done = notes.filter((n) => n.completed)

  async function addNote() {
    const value = content.trim()
    if (!value) return
    setAdding(true)
    try {
      await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: value, color }),
      })
      setContent("")
      setColor("default")
      await mutate()
    } finally {
      setAdding(false)
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl/Cmd + Enter adds the note; skip while an IME is composing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      addNote()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StickyNote className="size-5 text-primary" /> My notes &amp; daily tasks
          </DialogTitle>
          <DialogDescription>Jot down your tasks, tick them off when done, edit or delete anytime.</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <Textarea
            placeholder="Take a note… (e.g. Follow up with client X)"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={2}
            className="resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <ColorPicker value={color} onChange={setColor} />
            <Button size="sm" className="gap-1.5" onClick={addNote} disabled={adding || !content.trim()}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add
            </Button>
          </div>
        </div>

        <div className="max-h-[52vh] overflow-y-auto pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading notes…
            </div>
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
              <StickyNote className="size-8 opacity-40" />
              <p className="text-sm">No notes yet. Add your first task above.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {active.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {active.map((note) => (
                    <NoteCard key={note.id} note={note} onChanged={mutate} />
                  ))}
                </div>
              )}

              {done.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Completed ({done.length})
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {done.map((note) => (
                      <NoteCard key={note.id} note={note} onChanged={mutate} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
