"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Phone } from "lucide-react"

export type CallTarget = {
  id: number | null
  name: string | null
  number: string | null
}

const DEFAULT_DISPOSITIONS = [
  "Interested",
  "Not Interested",
  "Callback Requested",
  "Left Voicemail",
  "No Answer",
  "Wrong Number",
  "Follow Up",
] as const

/**
 * Manual call-logging dialog, shared across modules.
 *
 * Live in-browser calling has been removed. This dialog lets an agent place the
 * call on their own phone (via the `tel:` link) and then record the outcome.
 *
 * `apiBase` selects the module's calling endpoints — the component POSTs the log
 * to `${apiBase}`. `subjectKey` is the payload field used to link a call to a
 * record (e.g. "lead_id" for Sales, "application_id" for Recruitment).
 */
export function CallDialer({
  open,
  onOpenChange,
  target,
  onLogged,
  apiBase,
  subjectKey,
  title,
  dispositions = DEFAULT_DISPOSITIONS as unknown as string[],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: CallTarget | null
  onLogged?: () => void
  apiBase: string
  subjectKey: string
  title?: string
  dispositions?: string[]
}) {
  const [number, setNumber] = useState("")
  const [minutes, setMinutes] = useState("")
  const [seconds, setSeconds] = useState("")
  const [disposition, setDisposition] = useState<string>("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)

  // Reset the form whenever the dialog is opened for a new target.
  useEffect(() => {
    if (!open) return
    setNumber(target?.number ?? "")
    setMinutes("")
    setSeconds("")
    setDisposition("")
    setNotes("")
  }, [open, target])

  async function saveLog() {
    const dialed = number.trim()
    if (!dialed) {
      toast.error("Enter a phone number to log the call.")
      return
    }
    const durationSeconds =
      Math.max(0, Math.trunc(Number(minutes) || 0)) * 60 +
      Math.max(0, Math.trunc(Number(seconds) || 0))

    setSaving(true)
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [subjectKey]: target?.id ?? null,
          to_number: dialed,
          to_name: target?.name ?? null,
          status: "Completed",
          disposition: disposition || null,
          notes: notes || null,
          duration_seconds: durationSeconds,
        }),
      })
      if (res.ok) {
        toast.success("Call logged")
        onLogged?.()
        onOpenChange(false)
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data?.error || "Unable to log the call")
      }
    } finally {
      setSaving(false)
    }
  }

  const telHref = number.trim() ? `tel:${number.replace(/[^\d+]/g, "")}` : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? (target?.name ? `Call ${target.name}` : "Log a call")}</DialogTitle>
          <DialogDescription>
            Place the call from your phone, then record the outcome here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dialer-number">Phone number</Label>
            <div className="flex items-center gap-2">
              <Input
                id="dialer-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="+1 415 555 1234"
                inputMode="tel"
              />
              <Button asChild variant="outline" className="shrink-0 gap-2" disabled={!telHref}>
                <a href={telHref}>
                  <Phone className="size-4" /> Call
                </a>
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Duration</Label>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Minutes"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
                inputMode="numeric"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">min</span>
              <Input
                aria-label="Seconds"
                value={seconds}
                onChange={(e) => setSeconds(e.target.value.replace(/\D/g, ""))}
                placeholder="00"
                inputMode="numeric"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">sec</span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dialer-disposition">Outcome</Label>
            <Select value={disposition} onValueChange={(value) => setDisposition(value ?? "")}>
              <SelectTrigger id="dialer-disposition">
                <SelectValue placeholder="Select an outcome" />
              </SelectTrigger>
              <SelectContent>
                {dispositions.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dialer-notes">Notes</Label>
            <Textarea
              id="dialer-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did you discuss?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={saveLog} disabled={saving}>
            {saving ? "Saving..." : "Save call log"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
