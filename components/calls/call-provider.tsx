"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type {
  CallPermissions,
} from "./call-permissions"
import type {
  CallType,
  CallView,
  CallTargetInput,
  ConnState,
  UiPhase,
} from "./types"
import { CallUI } from "./call-ui"

const POLL_MS = 2000
const SIGNAL_MS = 800

export type UiCall = {
  view: CallView
  phase: UiPhase
  muted: boolean
  cameraOff: boolean
  connState: ConnState
  minimized: boolean
  error: string | null
  endedLabel: string | null
}

type CallContextValue = {
  permissions: CallPermissions
  currentUserId: number
  activeCallId: number | null
  startCall: (type: CallType, target: CallTargetInput) => Promise<void>
}

const Ctx = createContext<CallContextValue | null>(null)

export function useCalls() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useCalls must be used within <CallProvider>")
  return ctx
}

/** Map a getUserMedia error to a clear, user-facing message (Phase 16/17/18/85). */
function mediaErrorMessage(err: unknown, video: boolean): string {
  const e = err as { name?: string }
  switch (e?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return video
        ? "Camera/microphone permission denied. Enable it in your browser to make video calls."
        : "Microphone permission denied. Enable it in your browser to make calls."
    case "NotFoundError":
    case "OverconstrainedError":
      return video ? "No camera or microphone was found on this device." : "No microphone was found on this device."
    case "NotReadableError":
      return "Your camera or microphone is already in use by another application."
    default:
      return "Unable to access your microphone or camera."
  }
}

export function CallProvider({
  currentUserId,
  permissions,
  children,
}: {
  currentUserId: number
  permissions: CallPermissions
  children: React.ReactNode
}) {
  const [call, setCall] = useState<UiCall | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  // Refs mirror state for use inside interval callbacks without re-subscribing.
  const callRef = useRef<UiCall | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const engineIdRef = useRef<number | null>(null)
  const signalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const signalCursorRef = useRef<number>(0)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const offerCreatedRef = useRef(false)
  const connectedReportedRef = useRef(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const supported = typeof window !== "undefined" && !!navigator?.mediaDevices?.getUserMedia && !!window.RTCPeerConnection

  useEffect(() => {
    callRef.current = call
  }, [call])

  const patchCall = useCallback((patch: Partial<UiCall>) => {
    setCall((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  // ---- media -------------------------------------------------------------
  const acquireMedia = useCallback(async (type: CallType): Promise<MediaStream> => {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" })
    localStreamRef.current = stream
    setLocalStream(stream)
    return stream
  }, [])

  const releaseMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
  }, [])

  // ---- signalling --------------------------------------------------------
  const postSignal = useCallback(async (id: number, token: string, kind: string, payload: unknown) => {
    try {
      await fetch(`/api/calls/${id}/signals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-call-token": token },
        body: JSON.stringify({ kind, payload }),
      })
    } catch {
      /* transient; next tick retries higher-level state */
    }
  }, [])

  const drainPendingIce = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !pc.remoteDescription) return
    const queued = pendingIceRef.current
    pendingIceRef.current = []
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* ignore bad candidate */
      }
    }
  }, [])

  const teardownEngine = useCallback(() => {
    if (signalTimerRef.current) {
      clearInterval(signalTimerRef.current)
      signalTimerRef.current = null
    }
    try {
      pcRef.current?.getSenders().forEach((s) => s.track?.stop())
    } catch {
      /* noop */
    }
    try {
      pcRef.current?.close()
    } catch {
      /* noop */
    }
    pcRef.current = null
    engineIdRef.current = null
    signalCursorRef.current = 0
    pendingIceRef.current = []
    offerCreatedRef.current = false
    connectedReportedRef.current = false
    releaseMedia()
  }, [releaseMedia])

  const sendAction = useCallback(async (id: number, action: string, extra?: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/calls/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [])

  // ---- WebRTC engine -----------------------------------------------------
  const startEngine = useCallback(
    async (view: CallView) => {
      if (engineIdRef.current === view.id) return
      engineIdRef.current = view.id
      offerCreatedRef.current = false
      connectedReportedRef.current = false
      signalCursorRef.current = 0
      pendingIceRef.current = []

      let stream: MediaStream
      try {
        stream = await acquireMedia(view.callType)
      } catch (err) {
        const msg = mediaErrorMessage(err, view.callType === "video")
        patchCall({ error: msg })
        toast.error(msg)
        await sendAction(view.id, "end", { reason: "media_error" })
        return
      }

      const pc = new RTCPeerConnection({ iceServers: view.iceServers })
      pcRef.current = pc
      stream.getTracks().forEach((t) => pc.addTrack(t, stream))

      const remote = new MediaStream()
      setRemoteStream(remote)
      pc.ontrack = (ev) => {
        ev.streams[0]?.getTracks().forEach((t) => remote.addTrack(t))
        setRemoteStream(new MediaStream(remote.getTracks()))
      }
      pc.onicecandidate = (ev) => {
        if (ev.candidate) postSignal(view.id, view.token, "ice", ev.candidate.toJSON())
      }
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState
        if (st === "connected") {
          patchCall({ connState: "connected" })
          if (!connectedReportedRef.current) {
            connectedReportedRef.current = true
            sendAction(view.id, "connected")
          }
        } else if (st === "disconnected") {
          patchCall({ connState: "reconnecting" })
        } else if (st === "failed") {
          patchCall({ connState: "reconnecting", error: "Connection lost. Trying to reconnect…" })
          try {
            pc.restartIce()
          } catch {
            /* older browsers */
          }
        }
      }

      sendAction(view.id, "connecting")

      // Caller creates the offer; receiver answers when the offer arrives.
      if (view.role === "caller" && !offerCreatedRef.current) {
        offerCreatedRef.current = true
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          await postSignal(view.id, view.token, "offer", offer)
        } catch {
          /* will retry via renegotiation if needed */
        }
      }

      const pump = async () => {
        const cur = callRef.current
        if (!cur || cur.view.id !== view.id) return
        try {
          const res = await fetch(`/api/calls/${view.id}/signals?after=${signalCursorRef.current}`, {
            headers: { "x-call-token": view.token },
          })
          if (!res.ok) return
          const data = await res.json()
          for (const sig of data.signals as { id: number; kind: string; payload: any }[]) {
            signalCursorRef.current = Math.max(signalCursorRef.current, sig.id)
            const p = pcRef.current
            if (!p) continue
            if (sig.kind === "offer") {
              await p.setRemoteDescription(sig.payload)
              await drainPendingIce()
              const answer = await p.createAnswer()
              await p.setLocalDescription(answer)
              await postSignal(view.id, view.token, "answer", answer)
            } else if (sig.kind === "answer") {
              await p.setRemoteDescription(sig.payload)
              await drainPendingIce()
            } else if (sig.kind === "ice") {
              if (p.remoteDescription) {
                try {
                  await p.addIceCandidate(sig.payload)
                } catch {
                  /* ignore */
                }
              } else {
                pendingIceRef.current.push(sig.payload)
              }
            } else if (sig.kind === "bye") {
              endCall("hangup")
            }
          }
        } catch {
          /* transient */
        }
      }
      signalTimerRef.current = setInterval(pump, SIGNAL_MS)
      pump()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acquireMedia, drainPendingIce, patchCall, postSignal, sendAction],
  )

  // ---- public: start a call ---------------------------------------------
  const startCall = useCallback(
    async (type: CallType, target: CallTargetInput) => {
      if (!supported) {
        toast.error("This browser does not support internal calling.")
        return
      }
      if (callRef.current) {
        toast.message("You are already on a call.")
        return
      }
      if (type === "video" ? !permissions.video : !permissions.audio) {
        toast.error("You do not have permission to place this call.")
        return
      }
      // Acquire media in the click gesture so the permission prompt is reliable
      // and the caller sees a local preview while ringing.
      try {
        await acquireMedia(type)
      } catch (err) {
        const msg = mediaErrorMessage(err, type === "video")
        toast.error(msg)
        releaseMedia()
        return
      }
      try {
        const res = await fetch("/api/calls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            receiverEmployeeId: target.employeeId,
            callerEmployeeId: target.callerEmployeeId ?? null,
            callType: type,
            origin: target.origin ?? "employee",
            projectId: target.projectId ?? null,
            projectName: target.projectName ?? null,
            taskId: target.taskId ?? null,
            taskName: target.taskName ?? null,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          releaseMedia()
          toast.error(data.error || "Unable to place the call.")
          return
        }
        const view = data.session as CallView
        setCall({
          view,
          phase: "outgoing",
          muted: false,
          cameraOff: false,
          connState: "connecting",
          minimized: false,
          error: null,
          endedLabel: null,
        })
      } catch {
        releaseMedia()
        toast.error("Unable to place the call.")
      }
    },
    [acquireMedia, permissions, releaseMedia, supported],
  )

  // ---- receiver / caller controls ---------------------------------------
  const acceptIncoming = useCallback(async () => {
    const cur = callRef.current
    if (!cur) return
    try {
      await acquireMedia(cur.view.callType)
    } catch (err) {
      const msg = mediaErrorMessage(err, cur.view.callType === "video")
      toast.error(msg)
      await sendAction(cur.view.id, "reject", { reason: "media_error" })
      return
    }
    patchCall({ phase: "active", connState: "connecting" })
    await sendAction(cur.view.id, "accept")
  }, [acquireMedia, patchCall, sendAction])

  const rejectIncoming = useCallback(async () => {
    const cur = callRef.current
    if (!cur) return
    await sendAction(cur.view.id, "reject")
    teardownEngine()
    setCall(null)
  }, [sendAction, teardownEngine])

  const cancelOutgoing = useCallback(async () => {
    const cur = callRef.current
    if (!cur) return
    await sendAction(cur.view.id, "cancel")
    teardownEngine()
    setCall(null)
  }, [sendAction, teardownEngine])

  const endCall = useCallback(
    (reason = "hangup") => {
      const cur = callRef.current
      if (!cur) return
      postSignal(cur.view.id, cur.view.token, "bye", { reason })
      sendAction(cur.view.id, "end", { reason })
      teardownEngine()
      patchCall({ phase: "ended", endedLabel: "Call ended" })
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      clearTimerRef.current = setTimeout(() => setCall(null), 1500)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postSignal, sendAction, teardownEngine, patchCall],
  )

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !(callRef.current?.muted ?? false)
    stream.getAudioTracks().forEach((t) => (t.enabled = !next))
    patchCall({ muted: next })
  }, [patchCall])

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !(callRef.current?.cameraOff ?? false)
    stream.getVideoTracks().forEach((t) => (t.enabled = !next))
    patchCall({ cameraOff: next })
  }, [patchCall])

  const setMinimized = useCallback((min: boolean) => patchCall({ minimized: min }), [patchCall])

  // ---- start the engine when a call becomes active ----------------------
  useEffect(() => {
    if (!call) return
    const active = ["accepted", "connecting", "connected"].includes(call.view.status)
    if (active && call.phase !== "ended" && engineIdRef.current !== call.view.id) {
      startEngine(call.view)
    }
  }, [call, startEngine])

  // ---- global poll loop: presence + incoming/outgoing reconciliation -----
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch("/api/calls/poll")
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const server: CallView | null = data.session
        const recent = data.recent as { id: number; status: string; role: string; callType: string } | null
        const cur = callRef.current

        if (server) {
          if (!cur || cur.view.id !== server.id) {
            // Adopt a new session surfaced by the server (usually an incoming call).
            if (cur) teardownEngine()
            const phase: UiPhase =
              server.role === "receiver" && (server.status === "ringing" || server.status === "calling")
                ? "incoming"
                : ["accepted", "connecting", "connected"].includes(server.status)
                  ? "active"
                  : "outgoing"
            setCall({
              view: server,
              phase,
              muted: false,
              cameraOff: false,
              connState: "connecting",
              minimized: false,
              error: null,
              endedLabel: null,
            })
            if (phase === "incoming") notifyDesktop(server)
          } else {
            // Same session — advance status/phase.
            const nextPhase: UiPhase =
              cur.phase === "ended"
                ? "ended"
                : ["accepted", "connecting", "connected"].includes(server.status)
                  ? "active"
                  : cur.phase
            setCall({ ...cur, view: { ...server, token: cur.view.token }, phase: nextPhase })
          }
        } else if (cur && cur.phase !== "ended") {
          // The active session vanished — it ended somewhere. Reflect final state.
          const label =
            recent && (recent.id === cur.view.id || !recent)
              ? endedLabelFor(recent.status, cur.view.role)
              : "Call ended"
          teardownEngine()
          setCall({ ...cur, phase: "ended", endedLabel: label })
          if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
          clearTimerRef.current = setTimeout(() => setCall(null), 2000)
        }
      } catch {
        /* transient network */
      }
    }
    const iv = setInterval(poll, POLL_MS)
    poll()
    return () => {
      cancelled = true
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teardownEngine])

  // End cleanly on logout / tab close (Phase 75/76).
  useEffect(() => {
    function onUnload() {
      const cur = callRef.current
      if (cur) {
        navigator.sendBeacon?.(
          `/api/calls/${cur.view.id}/action`,
          new Blob([JSON.stringify({ action: "end", reason: "tab_closed" })], { type: "application/json" }),
        )
      }
    }
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [])

  return (
    <Ctx.Provider
      value={{ permissions, currentUserId, activeCallId: call?.view.id ?? null, startCall }}
    >
      {children}
      <CallUI
        call={call}
        localStream={localStream}
        remoteStream={remoteStream}
        onAccept={acceptIncoming}
        onReject={rejectIncoming}
        onCancel={cancelOutgoing}
        onEnd={() => endCall("hangup")}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onMinimize={() => setMinimized(true)}
        onMaximize={() => setMinimized(false)}
      />
    </Ctx.Provider>
  )
}

function endedLabelFor(status: string | undefined, role: string): string {
  switch (status) {
    case "rejected":
      return role === "caller" ? "Call declined" : "Call closed"
    case "missed":
      return role === "caller" ? "No answer" : "Missed call"
    case "busy":
      return "Employee is busy"
    case "failed":
      return "Call failed"
    case "cancelled":
      return role === "receiver" ? "Missed call" : "Call cancelled"
    default:
      return "Call ended"
  }
}

let desktopAsked = false
function notifyDesktop(view: CallView) {
  if (typeof window === "undefined" || !("Notification" in window)) return
  const show = () => {
    if (Notification.permission !== "granted") return
    try {
      new Notification(`Incoming ${view.callType} call`, {
        body: `${view.peer.name}${view.peer.designation ? ` · ${view.peer.designation}` : ""}`,
        icon: view.peer.photoUrl || undefined,
      })
    } catch {
      /* noop */
    }
  }
  if (Notification.permission === "granted") show()
  else if (Notification.permission === "default" && !desktopAsked) {
    desktopAsked = true
    Notification.requestPermission().then(() => show())
  }
}
