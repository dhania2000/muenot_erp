"use client"

import { CircleAlert, CircleCheck, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// Shared save/reset control used by every policy editor (Specs 59, 60, 63,
// 68, 71). Codex wires the actual persistence call — this component only
// manages the visual state machine: idle -> dirty -> saving -> saved | error.
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error"

export function PolicySaveBar({
  state,
  onSave,
  onReset,
  errorMessage,
}: {
  state: SaveState
  onSave: () => void
  onReset: () => void
  errorMessage?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <div aria-live="polite">
        {state === "idle" && <span className="text-xs text-muted-foreground">No changes to save</span>}
        {state === "dirty" && (
          <Badge variant="outline" className="text-[11px] font-normal">
            Unsaved changes
          </Badge>
        )}
        {state === "saving" && (
          <Badge variant="outline" className="gap-1 text-[11px] font-normal">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Saving…
          </Badge>
        )}
        {state === "saved" && (
          <Badge className="gap-1 border-transparent bg-emerald-600 text-[11px] text-white">
            <CircleCheck className="size-3" aria-hidden />
            Saved
          </Badge>
        )}
        {state === "error" && (
          <Badge variant="destructive" className="gap-1 text-[11px]">
            <CircleAlert className="size-3" aria-hidden />
            {errorMessage ?? "Failed to save"}
          </Badge>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={state === "saving" || state === "idle"}
        >
          Reset changes
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={state === "saving" || state === "idle"}>
          Save policy
        </Button>
      </div>
    </div>
  )
}
