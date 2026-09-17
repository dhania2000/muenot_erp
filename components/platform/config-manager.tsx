"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, Loader2, Lock, Pencil, X } from "lucide-react"
import type { PlatformConfigEntry } from "@/lib/platform-console"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function groupByCategory(entries: PlatformConfigEntry[]): Record<string, PlatformConfigEntry[]> {
  return entries.reduce<Record<string, PlatformConfigEntry[]>>((acc, e) => {
    ;(acc[e.category] ??= []).push(e)
    return acc
  }, {})
}

export function ConfigManager({ entries, canEdit }: { entries: PlatformConfigEntry[]; canEdit: boolean }) {
  const grouped = groupByCategory(entries)
  const categories = Object.keys(grouped).sort()

  return (
    <div className="flex flex-col gap-6">
      {categories.map((category) => (
        <Card key={category}>
          <CardHeader className="border-b">
            <CardTitle className="capitalize">{category}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border p-0">
            {grouped[category].map((entry) => (
              <ConfigRow key={entry.config_key} entry={entry} canEdit={canEdit} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ConfigRow({ entry, canEdit }: { entry: PlatformConfigEntry; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(entry.config_value ?? "")
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch("/api/platform/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: entry.config_key, value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update configuration")
        return
      }
      toast.success(`Updated ${entry.config_key}`)
      setEditing(false)
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <code className="text-sm font-medium">{entry.config_key}</code>
          {entry.is_secret ? (
            <Badge variant="secondary" className="gap-1">
              <Lock className="size-3" />
              Secret
            </Badge>
          ) : null}
        </div>
        {entry.description ? <span className="text-xs text-muted-foreground">{entry.description}</span> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:w-[22rem] sm:justify-end">
        {entry.is_secret ? (
          <span className="font-mono text-sm text-muted-foreground">••••••••</span>
        ) : editing ? (
          <>
            <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8" autoFocus />
            <Button size="icon" variant="ghost" className="size-8" onClick={save} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4 text-emerald-600" />}
              <span className="sr-only">Save</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => {
                setEditing(false)
                setValue(entry.config_value ?? "")
              }}
              disabled={busy}
            >
              <X className="size-4" />
              <span className="sr-only">Cancel</span>
            </Button>
          </>
        ) : (
          <>
            <span className="truncate font-mono text-sm">{entry.config_value || "—"}</span>
            {canEdit ? (
              <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                <span className="sr-only">Edit {entry.config_key}</span>
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
