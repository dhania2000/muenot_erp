"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { TelnyxRTC, ICall } from "@telnyx/webrtc"
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
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react"

export type CallTarget = {
  id: number | null
  name: string | null
  number: string | null
}

type CallState = "idle" | "connecting" | "ringing" | "in-progress" | "ended"

const DEFAULT_DISPOSITIONS = [
  "Interested",
  "Not Interested",
  "Callback Requested",
  "Left Voicemail",
  "No Answer",
  "Wrong Number",
  "Follow Up",
] as const

const DEFAULT_CONFIG_HINT =
  "Calling isn't configured yet. Add your Telnyx credentials (TELNYX_API_KEY, TELNYX_SIP_CONNECTION_ID, TELNYX_CALLER_ID) to enable in-browser calling."

function formatDuration(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0")
  return `${m}:${s}`
}

/**
 * In-browser Telnyx WebRTC dialer, shared across modules.
 *
 * `apiBase` selects the module's calling endpoints — the component talks to
 * `${apiBase}/token`, `${apiBase}` (POST to log) and `${apiBase}/${id}` (PATCH
 * outcome). `subjectKey` is the payload field used to link a call to a record
 * (e.g. "lead_id" for Sales, "application_id" for Recruitment).
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
  configHint = DEFAULT_CONFIG_HINT,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: CallTarget | null
  onLogged?: () => void
  apiBase: string
  subjectKey: string
  title?: string
  dispositions?: string[]
  configHint?: string
}) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [number, setNumber] = useState("")
  const [state, setState] = useState<CallState>("idle")
  const [muted, setMuted] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [disposition, setDisposition] = useState<string>("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  const clientRef = useRef<TelnyxRTC | null>(null)
  const callRef = useRef<ICall | null>(null)
  const callerIdRef = useRef<string>("")
  const readyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const callLogIdRef = useRef<number | null>(null)
  const secondsRef = useRef(0)

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const teardownClient = useCallback(() => {
    try {
      callRef.current?.hangup()
    } catch {}
    callRef.current = null
    try {
      clientRef.current?.disconnect()
    } catch {}
    clientRef.current = null
    readyRef.current = false
  }, [])

  // Reset all local state whenever the dialog is opened for a new target.
  useEffect(() => {
    if (!open) return
    setNumber(target?.number ?? "")
    setState("idle")
    setMuted(false)
    setSeconds(0)
    setDisposition("")
    setNotes("")
    setInitError(null)
    callLogIdRef.current = null
    setConfigured(null)

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${apiBase}/token`, { method: "POST" })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setInitError(data?.error || "Unable to start the dialer.")
          setConfigured(false)
          return
        }
        if (!data.configured) {
          setConfigured(false)
          return
        }
        callerIdRef.current = data.callerId || ""
        const { TelnyxRTC } = await import("@telnyx/webrtc")
        const client = new TelnyxRTC({ login_token: data.token })

        client.on("telnyx.ready", () => {
          readyRef.current = true
        })
        client.on("telnyx.error", (err: unknown) => {
          console.error("[call-dialer] telnyx error", err)
        })
        client.on("telnyx.notification", (notification: any) => {
          if (notification?.type !== "callUpdate" || !notification.call) return
          handleCallState(notification.call.state as string)
        })

        client.connect()
        clientRef.current = client
        setConfigured(true)
      } catch (err) {
        if (cancelled) return
        console.error("[call-dialer] init failed", err)
        setInitError("Could not initialize the calling device.")
        setConfigured(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target, apiBase])

  // Clean up the client and timer when the dialog fully closes.
  useEffect(() => {
    if (open) return
    stopTimer()
    teardownClient()
  }, [open, stopTimer, teardownClient])

  useEffect(() => {
    return () => {
      stopTimer()
      teardownClient()
    }
  }, [stopTimer, teardownClient])

  useEffect(() => {
    secondsRef.current = seconds
  }, [seconds])

  // Map Telnyx WebRTC call states onto our UI state machine.
  function handleCallState(telnyxState: string) {
    switch (telnyxState) {
      case "new":
      case "requesting":
      case "trying":
        setState("connecting")
        break
      case "ringing":
      case "early":
        setState("ringing")
        break
      case "active":
        setState("in-progress")
        stopTimer()
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
        break
      case "hangup":
      case "destroy":
        finishCall("Completed")
        break
      default:
        break
    }
  }

  async function logInitialCall(dialed: string) {
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [subjectKey]: target?.id ?? null,
          to_number: dialed,
          to_name: target?.name ?? null,
          status: "Initiated",
        }),
      })
      const data = await res.json()
      if (res.ok) callLogIdRef.current = data.id
    } catch (err) {
      console.error("[call-dialer] failed to log call", err)
    }
  }

  async function startCall() {
    const client = clientRef.current
    const dialed = number.trim()
    if (!client || !dialed) return

    setState("connecting")
    setSeconds(0)
    await logInitialCall(dialed)

    try {
      const call = client.newCall({
        destinationNumber: dialed,
        callerNumber: callerIdRef.current || undefined,
        audio: true,
        video: false,
      })
      callRef.current = call
    } catch (err) {
      console.error("[call-dialer] connect failed", err)
      toast.error("Unable to place the call.")
      finishCall("Failed")
    }
  }

  function finishCall(status: "Completed" | "Canceled" | "Failed") {
    stopTimer()
    setState((prev) => (prev === "ended" ? prev : "ended"))
    const callId = callLogIdRef.current
    const finalDuration = secondsRef.current
    if (callId) {
      fetch(`${apiBase}/${callId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, duration_seconds: finalDuration }),
      }).catch(() => {})
    }
  }

  function hangup() {
    try {
      callRef.current?.hangup()
    } catch {}
  }

  function toggleMute() {
    const call = callRef.current
    if (!call) return
    const next = !muted
    try {
      if (next) call.muteAudio()
      else call.unmuteAudio()
    } catch {}
    setMuted(next)
  }

  async function saveOutcome() {
    const callId = callLogIdRef.current
    if (!callId) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${apiBase}/${callId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disposition: disposition || null,
          notes: notes || null,
          duration_seconds: secondsRef.current,
        }),
      })
      if (res.ok) {
        toast.success("Call logged")
        onLogged?.()
        onOpenChange(false)
      } else {
        toast.error("Unable to save call notes")
      }
    } finally {
      setSaving(false)
    }
  }

  const isLive = state === "connecting" || state === "ringing" || state === "in-progress"

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Prevent closing mid-call; require hang up first.
        if (!next && isLive) {
          toast.message("End the call before closing.")
          return
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? (target?.name ? `Call ${target.name}` : "Call")}</DialogTitle>
          <DialogDescription>Place a call directly from your browser.</DialogDescription>
        </DialogHeader>

        {configured === false ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            {initError || configHint}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dialer-number">Phone number</Label>
              <Input
                id="dialer-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="+1 415 555 1234"
                disabled={isLive || state === "ended"}
                inputMode="tel"
              />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
              <StatusBadge state={state} />
              <span className="font-mono text-sm tabular-nums text-muted-foreground">
                {formatDuration(seconds)}
              </span>
            </div>

            <div className="flex items-center justify-center gap-3">
              {!isLive && state !== "ended" && (
                <Button
                  onClick={startCall}
                  disabled={configured === null || !number.trim()}
                  className="gap-2"
                >
                  <Phone className="size-4" /> Call
                </Button>
              )}
              {isLive && (
                <>
                  <Button variant="outline" onClick={toggleMute} className="gap-2">
                    {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                    {muted ? "Unmute" : "Mute"}
                  </Button>
                  <Button variant="destructive" onClick={hangup} className="gap-2">
                    <PhoneOff className="size-4" /> Hang up
                  </Button>
                </>
              )}
            </div>

            {state === "ended" && (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
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
            )}
          </div>
        )}

        <DialogFooter>
          {state === "ended" ? (
            <Button onClick={saveOutcome} disabled={saving}>
              {saving ? "Saving..." : "Save & close"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLive}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatusBadge({ state }: { state: CallState }) {
  const map: Record<CallState, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    idle: { label: "Ready", variant: "outline" },
    connecting: { label: "Connecting…", variant: "secondary" },
    ringing: { label: "Ringing…", variant: "secondary" },
    "in-progress": { label: "In call", variant: "default" },
    ended: { label: "Call ended", variant: "outline" },
  }
  const { label, variant } = map[state]
  return <Badge variant={variant}>{label}</Badge>
}
