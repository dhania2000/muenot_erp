"use client"

import { useEffect, useRef, useState } from "react"
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  PhoneIncoming,
  Video,
  VideoOff,
  Minimize2,
  Maximize2,
  User,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { UiCall } from "./call-provider"

function Avatar({ name, photoUrl, size = 64 }: { name: string; photoUrl: string | null; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted"
      style={{ width: size, height: size }}
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl || "/placeholder.svg"} alt={name} className="size-full object-cover" />
      ) : (
        <User className="text-muted-foreground" style={{ width: size * 0.45, height: size * 0.45 }} />
      )}
    </div>
  )
}

function fmt(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0")
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0")
  return `${m}:${s}`
}

function useCallTimer(answeredAt: string | null, active: boolean) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!active || !answeredAt) {
      setSecs(0)
      return
    }
    const base = new Date(answeredAt).getTime()
    const tick = () => setSecs(Math.max(0, Math.round((Date.now() - base) / 1000)))
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [answeredAt, active])
  return secs
}

export type CallUIProps = {
  call: UiCall | null
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  onAccept: () => void
  onReject: () => void
  onCancel: () => void
  onEnd: () => void
  onToggleMute: () => void
  onToggleCamera: () => void
  onMinimize: () => void
  onMaximize: () => void
}

export function CallUI(props: CallUIProps) {
  const { call } = props
  if (!call) return null
  if (call.phase === "incoming") return <IncomingCall {...props} />
  return <ActiveOrOutgoing {...props} />
}

function ConnLabel({ call }: { call: UiCall }) {
  const status = call.view.status
  let label = "Connecting…"
  if (call.phase === "outgoing") label = status === "ringing" || status === "calling" ? "Calling…" : "Connecting…"
  else if (call.phase === "ended") label = call.endedLabel || "Call ended"
  else if (call.connState === "connected") label = "Connected"
  else if (call.connState === "reconnecting") label = "Reconnecting…"
  else if (status === "accepted") label = "Connecting…"
  return (
    <span className="text-xs text-muted-foreground" aria-live="polite">
      {label}
    </span>
  )
}

function ContextLine({ call }: { call: UiCall }) {
  const c = call.view.context
  const parts: string[] = []
  if (c.projectName) parts.push(`Project: ${c.projectName}`)
  if (c.taskName) parts.push(`Task: ${c.taskName}`)
  if (!parts.length) return null
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>
}

function IncomingCall({ call, onAccept, onReject }: CallUIProps) {
  if (!call) return null
  const peer = call.view.peer
  const isVideo = call.view.callType === "video"
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-2xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <PhoneIncoming className="size-3.5" />
            Incoming {isVideo ? "video" : "audio"} call
          </span>
          <Avatar name={peer.name} photoUrl={peer.photoUrl} size={88} />
          <div>
            <h2 className="text-lg font-semibold">{peer.name}</h2>
            <p className="text-sm text-muted-foreground">
              {[peer.designation, peer.department].filter(Boolean).join(" · ") || "Employee"}
            </p>
            <ContextLine call={call} />
          </div>
        </div>
        <div className="mt-6 flex items-center justify-center gap-6">
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              variant="destructive"
              className="size-14 rounded-full"
              onClick={onReject}
              aria-label="Reject call"
            >
              <PhoneOff className="size-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              className="size-14 rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={onAccept}
              aria-label="Accept call"
            >
              {isVideo ? <Video className="size-6" /> : <Phone className="size-6" />}
            </Button>
            <span className="text-xs text-muted-foreground">Accept</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActiveOrOutgoing(props: CallUIProps) {
  const { call, localStream, remoteStream, onCancel, onEnd, onToggleMute, onToggleCamera, onMinimize, onMaximize } = props
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream
  }, [localStream])
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current && remoteStream) remoteAudioRef.current.srcObject = remoteStream
  }, [remoteStream])

  const isConnected = call ? call.connState === "connected" : false
  const secs = useCallTimer(call?.view.answeredAt ?? null, isConnected)
  if (!call) return null

  const peer = call.view.peer
  const isVideo = call.view.callType === "video"
  const isOutgoing = call.phase === "outgoing"
  const canControl = call.phase === "active"

  // Remote audio always plays (audio + video calls). Hidden element.
  const audioEl = <audio ref={remoteAudioRef} autoPlay className="hidden" />

  if (call.minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-[100] w-64 rounded-xl border bg-card p-3 shadow-2xl">
        {audioEl}
        <div className="flex items-center gap-3">
          <Avatar name={peer.name} photoUrl={peer.photoUrl} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{peer.name}</p>
            <div className="flex items-center gap-1.5">
              {isConnected && <span className="font-mono text-xs tabular-nums">{fmt(secs)}</span>}
              <ConnLabel call={call} />
            </div>
          </div>
          <Button size="icon" variant="ghost" className="size-8" onClick={onMaximize} aria-label="Expand call">
            <Maximize2 className="size-4" />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-center gap-2">
          {canControl && (
            <Button size="icon" variant={call.muted ? "secondary" : "outline"} className="size-9" onClick={onToggleMute} aria-label={call.muted ? "Unmute" : "Mute"}>
              {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
          )}
          <Button size="icon" variant="destructive" className="size-9" onClick={isOutgoing ? onCancel : onEnd} aria-label="End call">
            <PhoneOff className="size-4" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      {audioEl}
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge variant={isVideo ? "default" : "secondary"} className="gap-1">
              {isVideo ? <Video className="size-3" /> : <Phone className="size-3" />}
              {isVideo ? "Video" : "Audio"}
            </Badge>
            <ConnLabel call={call} />
            {call.error && <span className="text-xs text-destructive">{call.error}</span>}
          </div>
          <Button size="icon" variant="ghost" className="size-8" onClick={onMinimize} aria-label="Minimize call">
            <Minimize2 className="size-4" />
          </Button>
        </div>

        {/* Stage */}
        <div className="relative flex min-h-[320px] flex-1 items-center justify-center bg-muted/40">
          {isVideo ? (
            <>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className={cn("size-full max-h-[52vh] object-cover", !remoteStream && "hidden")}
              />
              {!remoteStream && (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Avatar name={peer.name} photoUrl={peer.photoUrl} size={96} />
                  <p className="text-sm text-muted-foreground">Waiting for video…</p>
                </div>
              )}
              {/* Local preview */}
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={cn(
                  "absolute bottom-3 right-3 h-28 w-40 rounded-lg border-2 border-background object-cover shadow-lg",
                  call.cameraOff && "hidden",
                )}
              />
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <Avatar name={peer.name} photoUrl={peer.photoUrl} size={112} />
            </div>
          )}
        </div>

        {/* Identity + timer */}
        <div className="border-t px-4 py-3 text-center">
          <h2 className="text-lg font-semibold">{peer.name}</h2>
          <p className="text-sm text-muted-foreground">
            {[peer.designation, peer.department].filter(Boolean).join(" · ") || "Employee"}
          </p>
          <ContextLine call={call} />
          {isConnected && <p className="mt-1 font-mono text-sm tabular-nums">{fmt(secs)}</p>}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-3 border-t px-4 py-4">
          {canControl && (
            <Button
              size="icon"
              variant={call.muted ? "secondary" : "outline"}
              className="size-12 rounded-full"
              onClick={onToggleMute}
              aria-label={call.muted ? "Unmute microphone" : "Mute microphone"}
            >
              {call.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </Button>
          )}
          {canControl && isVideo && (
            <Button
              size="icon"
              variant={call.cameraOff ? "secondary" : "outline"}
              className="size-12 rounded-full"
              onClick={onToggleCamera}
              aria-label={call.cameraOff ? "Turn camera on" : "Turn camera off"}
            >
              {call.cameraOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
            </Button>
          )}
          <Button
            size="icon"
            variant="destructive"
            className="size-12 rounded-full"
            onClick={isOutgoing ? onCancel : onEnd}
            aria-label={isOutgoing ? "Cancel call" : "End call"}
          >
            <PhoneOff className="size-5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
