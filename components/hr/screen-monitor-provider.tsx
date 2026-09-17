"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MonitorPlay, ShieldAlert } from "lucide-react"

// ---------------------------------------------------------------------------
// Screen Monitor Provider — the browser-side capture engine.
//
// It is deliberately decoupled from attendance: the header Clock In/Out button
// calls `startMonitoring()` / `stopMonitoring()` through this context. Capture
// only ever begins AFTER the employee explicitly grants the browser
// screen-share permission (getDisplayMedia). One JPEG frame is uploaded every
// `captureIntervalSeconds` while a session is Active. Ending the shared stream,
// clocking out, or closing the tab all stop capture. Nothing is recorded before
// consent or after stop.
// ---------------------------------------------------------------------------

type PublicSettings = {
  enabled: boolean
  captureIntervalSeconds: number
  imageQuality: number
  maxWidth: number
  retentionDays: number
}

type MonitorContextValue = {
  active: boolean
  /** Called after a successful Clock In. Prompts for consent, then captures. */
  startMonitoring: () => Promise<void>
  /** Called after a successful Clock Out (or manual stop). */
  stopMonitoring: (reason?: string) => Promise<void>
}

const MonitorContext = createContext<MonitorContextValue | null>(null)

export function useScreenMonitor(): MonitorContextValue {
  const ctx = useContext(MonitorContext)
  if (!ctx) {
    // Rendered outside the provider (should not happen) — no-op fallback.
    return { active: false, startMonitoring: async () => {}, stopMonitoring: async () => {} }
  }
  return ctx
}

function detectBrowserOs(): { browser: string; os: string } {
  if (typeof navigator === "undefined") return { browser: "Unknown", os: "Unknown" }
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Unknown"
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : /Android/.test(ua) ? "Android" : "Unknown"
  return { browser, os }
}

export function ScreenMonitorProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionPkRef = useRef<number | null>(null)
  const sequenceRef = useRef(0)
  const settingsRef = useRef<PublicSettings | null>(null)
  const uploadingRef = useRef(false)
  const consentResolveRef = useRef<((granted: boolean) => void) | null>(null)

  const teardownStream = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setActive(false)
  }, [])

  const patchSession = useCallback(async (op: "stop" | "revoke", reason?: string) => {
    const pk = sessionPkRef.current
    if (!pk) return
    try {
      await fetch("/api/hr/screen-monitoring/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: pk, op, reason }),
      })
    } catch {
      // Best-effort — the cron stale sweep will close it if this fails.
    }
  }, [])

  const stopMonitoring = useCallback(
    async (reason = "clock_out") => {
      const pk = sessionPkRef.current
      teardownStream()
      if (pk) {
        await patchSession("stop", reason)
        sessionPkRef.current = null
        sequenceRef.current = 0
      }
    },
    [patchSession, teardownStream],
  )

  // Capture a single frame and upload it. Guarded so a slow upload never stacks.
  const captureOnce = useCallback(async () => {
    if (uploadingRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const pk = sessionPkRef.current
    const settings = settingsRef.current
    if (!video || !canvas || !pk || !settings) return
    if (!video.videoWidth || !video.videoHeight) return

    const scale = Math.min(1, settings.maxWidth / video.videoWidth)
    const w = Math.max(1, Math.round(video.videoWidth * scale))
    const h = Math.max(1, Math.round(video.videoHeight * scale))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", settings.imageQuality),
    )
    if (!blob) return

    const sequence = sequenceRef.current + 1
    const form = new FormData()
    form.append("sessionId", String(pk))
    form.append("captureSequence", String(sequence))
    form.append("width", String(w))
    form.append("height", String(h))
    form.append("sourceType", "screen")
    form.append("file", blob, `capture-${sequence}.jpg`)

    uploadingRef.current = true
    try {
      const res = await fetch("/api/hr/screen-monitoring/screenshot", { method: "POST", body: form })
      if (res.ok) {
        sequenceRef.current = sequence
      } else if (res.status === 409) {
        // Session no longer active (e.g. clock out raced) — stop capturing.
        teardownStream()
      }
    } catch {
      // Transient network failure — skip this frame; the next tick retries.
    } finally {
      uploadingRef.current = false
    }
  }, [teardownStream])

  const beginCaptureLoop = useCallback(() => {
    const settings = settingsRef.current
    if (!settings) return
    setActive(true)
    // First frame shortly after consent, then on the configured cadence.
    setTimeout(() => void captureOnce(), 1500)
    intervalRef.current = setInterval(() => void captureOnce(), settings.captureIntervalSeconds * 1000)
  }, [captureOnce])

  const startMonitoring = useCallback(async () => {
    // Load current settings first — respect the global enabled flag (Phase 7).
    let settings: PublicSettings | null = null
    try {
      const res = await fetch("/api/hr/screen-monitoring/session")
      const json = await res.json()
      settings = json?.settings ?? null
    } catch {
      settings = null
    }
    if (!settings || !settings.enabled) return
    settingsRef.current = settings

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      await recordSession(false)
      toast.error("Screen monitoring is not supported in this browser.")
      return
    }

    // Ask for consent via our own dialog before the native permission prompt.
    const granted = await new Promise<boolean>((resolve) => {
      consentResolveRef.current = resolve
      setConsentOpen(true)
    })
    consentResolveRef.current = null
    setConsentOpen(false)
    if (!granted) {
      await recordSession(false)
      toast.message("Screen monitoring declined. Your attendance is still recorded.")
      return
    }

    // Native browser screen-share prompt.
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false,
      })
    } catch {
      await recordSession(false)
      toast.error("Screen sharing permission was denied. Attendance is still recorded.")
      return
    }

    streamRef.current = stream
    const video = ensureVideo()
    video.srcObject = stream
    try {
      await video.play()
    } catch {
      // Autoplay policies — a muted, in-DOM video should still play.
    }

    // If the user stops sharing from the browser UI, treat it as a revoke.
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        void patchSession("revoke", "stream_ended")
        teardownStream()
        toast.message("Screen sharing stopped. Monitoring paused.")
      })
    })

    const ok = await recordSession(true)
    if (!ok) {
      teardownStream()
      return
    }
    beginCaptureLoop()
    toast.success("Screen monitoring started")

    // Record (or reuse) the server session. Returns true when capture may start.
    async function recordSession(permissionGranted: boolean): Promise<boolean> {
      const { browser, os } = detectBrowserOs()
      try {
        const res = await fetch("/api/hr/screen-monitoring/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissionGranted, browser, os, sourceType: "screen" }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (permissionGranted) toast.error(json?.error || "Could not start monitoring.")
          return false
        }
        if (json?.disabled) return false
        if (json?.session?.id) {
          sessionPkRef.current = Number(json.session.id)
          sequenceRef.current = Number(json.session.capture_count || 0)
        }
        return permissionGranted && Boolean(json?.session?.id)
      } catch {
        if (permissionGranted) toast.error("Network error starting monitoring.")
        return false
      }
    }
  }, [beginCaptureLoop, patchSession, teardownStream])

  function ensureVideo(): HTMLVideoElement {
    if (!videoRef.current) {
      const v = document.createElement("video")
      v.muted = true
      v.playsInline = true
      v.style.position = "fixed"
      v.style.width = "1px"
      v.style.height = "1px"
      v.style.opacity = "0"
      v.style.pointerEvents = "none"
      v.style.left = "-9999px"
      document.body.appendChild(v)
      videoRef.current = v
    }
    return videoRef.current
  }

  // Stop capture cleanly if the tab is closed/navigated away.
  useEffect(() => {
    const onUnload = () => {
      const pk = sessionPkRef.current
      if (pk && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({ sessionId: pk, op: "stop", reason: "tab_closed" })], {
          type: "application/json",
        })
        navigator.sendBeacon("/api/hr/screen-monitoring/session", blob)
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    window.addEventListener("pagehide", onUnload)
    return () => {
      window.removeEventListener("pagehide", onUnload)
      if (intervalRef.current) clearInterval(intervalRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (videoRef.current?.parentNode) videoRef.current.parentNode.removeChild(videoRef.current)
    }
  }, [])

  return (
    <MonitorContext.Provider value={{ active, startMonitoring, stopMonitoring }}>
      {children}

      {active ? (
        <div
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-lg"
          role="status"
          aria-live="polite"
        >
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-red-600" />
          </span>
          <MonitorPlay className="size-3.5 text-muted-foreground" />
          Screen monitoring active
        </div>
      ) : null}

      <Dialog
        open={consentOpen}
        onOpenChange={(open) => {
          if (!open && consentResolveRef.current) {
            consentResolveRef.current(false)
            consentResolveRef.current = null
          }
          setConsentOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-amber-500" />
              Screen monitoring consent
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-left">
              <span className="block">
                While you are clocked in, a screenshot of your shared screen is captured about once a minute for
                attendance and compliance records. Capturing only starts after you approve the browser&apos;s screen-share
                prompt, and stops the moment you clock out or end sharing.
              </span>
              <span className="block text-muted-foreground">
                Choose the screen or window to share in the next prompt. You can decline — your attendance is still
                recorded either way.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                consentResolveRef.current?.(false)
                consentResolveRef.current = null
                setConsentOpen(false)
              }}
            >
              Not now
            </Button>
            <Button
              onClick={() => {
                consentResolveRef.current?.(true)
                consentResolveRef.current = null
                setConsentOpen(false)
              }}
            >
              Share screen &amp; continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </MonitorContext.Provider>
  )
}
