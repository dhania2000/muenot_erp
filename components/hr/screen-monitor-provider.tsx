"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { MonitorPlay } from "lucide-react"

// ---------------------------------------------------------------------------
// Screen Monitor Provider — the browser-side capture + live-broadcast engine.
//
// It is deliberately decoupled from attendance: the header Clock In/Out button
// calls `startMonitoring()` / `stopMonitoring()` through this context. On Clock
// In the browser's own native screen-share picker opens immediately (there is
// no extra in-app consent step). Once the employee approves the picker:
//   - one JPEG frame is uploaded every `captureIntervalSeconds` for the record
//     timeline, and
//   - HR can open a direct, peer-to-peer live view of the shared screen. The
//     server only relays the WebRTC handshake; the video never touches it.
// Ending the shared stream, clocking out, or closing the tab stops everything.
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
  /** Called after a successful Clock In. Opens the native picker, then captures. */
  startMonitoring: () => Promise<void>
  /** Called after a successful Clock Out (or manual stop). */
  stopMonitoring: (reason?: string) => Promise<void>
}

const MonitorContext = createContext<MonitorContextValue | null>(null)

// Public STUN only — enough for most direct/NAT-traversable connections. No
// media is relayed through the app; this just helps peers find each other.
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }]

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

  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionPkRef = useRef<number | null>(null)
  const sequenceRef = useRef(0)
  const settingsRef = useRef<PublicSettings | null>(null)
  const uploadingRef = useRef(false)

  // Live-view (WebRTC broadcaster) state.
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const signalBusyRef = useRef(false)

  const closeAllPeers = useCallback(() => {
    peersRef.current.forEach((pc) => {
      try {
        pc.close()
      } catch {
        // ignore
      }
    })
    peersRef.current.clear()
  }, [])

  const teardownStream = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (signalPollRef.current) {
      clearInterval(signalPollRef.current)
      signalPollRef.current = null
    }
    closeAllPeers()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setActive(false)
  }, [closeAllPeers])

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

  // -------------------------------------------------------------------------
  // Unmonitored-time accrual. While clocked in but NOT sharing the entire
  // screen (permission denied, an unsupported browser, a window/tab share, or
  // sharing stopped mid-session), the elapsed time must not count as
  // attendance. We report it — with no grace — to the attendance idle endpoint,
  // which reclassifies it from worked hours into break at clock-out. Reporting
  // runs continuously (about once a minute) so the time reaches the server
  // before the employee clocks out.
  // -------------------------------------------------------------------------
  const unmonitoredSinceRef = useRef<number | null>(null)
  const unmonitoredTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reportUnmonitored = useCallback((useBeacon = false) => {
    const since = unmonitoredSinceRef.current
    if (since === null) return
    const minutes = (Date.now() - since) / 60000
    if (minutes < 1) return
    const payload = JSON.stringify({ minutes })
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/hr/attendance/idle", new Blob([payload], { type: "application/json" }))
    } else {
      void fetch("/api/hr/attendance/idle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }
    unmonitoredSinceRef.current = Date.now()
  }, [])

  const startUnmonitored = useCallback(() => {
    if (unmonitoredSinceRef.current !== null) return
    unmonitoredSinceRef.current = Date.now()
    unmonitoredTimerRef.current = setInterval(() => reportUnmonitored(false), 60000)
  }, [reportUnmonitored])

  const stopUnmonitored = useCallback(
    (useBeacon = false) => {
      if (unmonitoredTimerRef.current) {
        clearInterval(unmonitoredTimerRef.current)
        unmonitoredTimerRef.current = null
      }
      reportUnmonitored(useBeacon)
      unmonitoredSinceRef.current = null
    },
    [reportUnmonitored],
  )

  const stopMonitoring = useCallback(
    async (reason = "clock_out") => {
      const pk = sessionPkRef.current
      stopUnmonitored()
      teardownStream()
      if (pk) {
        await patchSession("stop", reason)
        sessionPkRef.current = null
        sequenceRef.current = 0
      }
    },
    [patchSession, teardownStream, stopUnmonitored],
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

  // -------------------------------------------------------------------------
  // Live view — broadcaster side. Each HR viewer negotiates its own peer
  // connection through the polled signaling relay. We answer offers, trickle
  // ICE, and tear a peer down on `bye` or when the stream ends.
  // -------------------------------------------------------------------------
  const postSignal = useCallback(async (viewerId: string, kind: string, payload: unknown) => {
    const pk = sessionPkRef.current
    if (!pk) return
    try {
      await fetch("/api/hr/screen-monitoring/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: pk, viewerId, role: "broadcaster", kind, payload }),
      })
    } catch {
      // Transient — the viewer retries by re-offering.
    }
  }, [])

  const handleViewerOffer = useCallback(
    async (viewerId: string, offer: RTCSessionDescriptionInit) => {
      const stream = streamRef.current
      if (!stream) return

      // Replace any prior connection for this viewer (fresh renegotiation).
      const existing = peersRef.current.get(viewerId)
      if (existing) {
        try {
          existing.close()
        } catch {
          // ignore
        }
        peersRef.current.delete(viewerId)
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peersRef.current.set(viewerId, pc)
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))

      pc.onicecandidate = (event) => {
        if (event.candidate) void postSignal(viewerId, "ice", event.candidate.toJSON())
      }
      pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          pc.close()
          peersRef.current.delete(viewerId)
        }
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await postSignal(viewerId, "answer", answer)
      } catch {
        pc.close()
        peersRef.current.delete(viewerId)
      }
    },
    [postSignal],
  )

  const pollSignals = useCallback(async () => {
    const pk = sessionPkRef.current
    if (!pk || signalBusyRef.current) return
    signalBusyRef.current = true
    try {
      const res = await fetch(
        `/api/hr/screen-monitoring/signal?sessionId=${pk}&role=broadcaster&viewerId=broadcaster`,
        { cache: "no-store" },
      )
      if (!res.ok) return
      const json = (await res.json()) as {
        messages: { viewerId: string; kind: string; payload: unknown }[]
      }
      // Process in order so an offer is always applied before its ICE.
      for (const msg of json.messages ?? []) {
        if (msg.kind === "offer") {
          await handleViewerOffer(msg.viewerId, msg.payload as RTCSessionDescriptionInit)
        } else if (msg.kind === "ice") {
          const pc = peersRef.current.get(msg.viewerId)
          if (pc && msg.payload) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.payload as RTCIceCandidateInit))
            } catch {
              // ignore late/duplicate candidates
            }
          }
        } else if (msg.kind === "bye") {
          const pc = peersRef.current.get(msg.viewerId)
          if (pc) {
            pc.close()
            peersRef.current.delete(msg.viewerId)
          }
        }
      }
    } catch {
      // Transient network failure — next tick retries.
    } finally {
      signalBusyRef.current = false
    }
  }, [handleViewerOffer])

  const beginCaptureLoop = useCallback(() => {
    const settings = settingsRef.current
    if (!settings) return
    setActive(true)
    // First frame shortly after consent, then on the configured cadence.
    setTimeout(() => void captureOnce(), 1500)
    intervalRef.current = setInterval(() => void captureOnce(), settings.captureIntervalSeconds * 1000)
    // Listen for HR live-view connection requests.
    signalPollRef.current = setInterval(() => void pollSignals(), 2000)
  }, [captureOnce, pollSignals])

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
      startUnmonitored()
      toast.error("Screen sharing is not supported in this browser, so this time will count as break, not attendance.")
      return
    }

    // Native browser screen-share prompt opens immediately on Clock In. We force
    // the "entire screen" surface: the hints below make the monitor the default/
    // only sensible choice, and the post-grant check rejects a window/tab share
    // so only a full-screen capture is ever accepted. A higher frame rate keeps
    // the HR live view smooth (screenshots still sample once per interval).
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 }, displaySurface: "monitor" },
        audio: false,
        // Steer the browser picker toward the whole screen and away from
        // per-tab/window sharing where these options are supported.
        monitorTypeSurfaces: "include",
        surfaceSwitching: "exclude",
        selfBrowserSurface: "exclude",
        preferCurrentTab: false,
      } as DisplayMediaStreamOptions)
    } catch {
      await recordSession(false)
      startUnmonitored()
      toast.error("Screen sharing was denied. This time will count as break until you share your entire screen.")
      return
    }

    // Enforce entire-screen sharing: if the employee picked a window or a tab,
    // reject the stream and ask them to share their whole screen instead.
    const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface
    if (displaySurface && displaySurface !== "monitor") {
      stream.getTracks().forEach((track) => track.stop())
      await recordSession(false)
      startUnmonitored()
      toast.error(
        "Please share your entire screen, not a single window or tab. Until then this time will count as break, not attendance.",
      )
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

    // If the user stops sharing from the browser UI, treat it as a revoke and
    // begin accruing the remaining time as break — an unshared screen never
    // counts as attendance.
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        void patchSession("revoke", "stream_ended")
        teardownStream()
        startUnmonitored()
        toast.message("Screen sharing stopped — this time will count as break, not attendance.")
      })
    })

    const ok = await recordSession(true)
    if (!ok) {
      teardownStream()
      return
    }
    // Full screen is being shared: any earlier unmonitored stretch ends here.
    stopUnmonitored()
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
  }, [beginCaptureLoop, patchSession, teardownStream, startUnmonitored, stopUnmonitored])

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
      // Bank any unshared-screen time as break before the tab goes away.
      const since = unmonitoredSinceRef.current
      if (since !== null && typeof navigator !== "undefined" && navigator.sendBeacon) {
        const minutes = (Date.now() - since) / 60000
        if (minutes >= 1) {
          navigator.sendBeacon(
            "/api/hr/attendance/idle",
            new Blob([JSON.stringify({ minutes })], { type: "application/json" }),
          )
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    window.addEventListener("pagehide", onUnload)
    return () => {
      window.removeEventListener("pagehide", onUnload)
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (signalPollRef.current) clearInterval(signalPollRef.current)
      if (unmonitoredTimerRef.current) clearInterval(unmonitoredTimerRef.current)
      peersRef.current.forEach((pc) => {
        try {
          pc.close()
        } catch {
          // ignore
        }
      })
      peersRef.current.clear()
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

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </MonitorContext.Provider>
  )
}
