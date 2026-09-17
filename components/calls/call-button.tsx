"use client"

import { Phone, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCalls } from "./call-provider"
import { usePresence, PRESENCE_META, type PresenceStatus } from "./use-presence"
import type { CallTargetInput } from "./types"

/**
 * The single reusable internal-calling action, dropped into any module that
 * lists employees (Employee Profile, Employee List, Project Members, Task
 * Assignees, Operations Resources — Phase 53/60/93). Audio and/or video buttons
 * appear only when the current user holds the matching RBAC permission
 * (Phase 4/62) and are disabled for inactive/no-login employees.
 */
export function CallButtons({
  target,
  size = "icon",
  showLabels = false,
  className,
  disabled: disabledProp = false,
  disabledReason,
}: {
  target: CallTargetInput
  size?: "icon" | "sm" | "default"
  showLabels?: boolean
  className?: string
  /** Force-disable, e.g. the employee has no login account or is inactive. */
  disabled?: boolean
  disabledReason?: string
}) {
  const { permissions, startCall, activeCallId } = useCalls()
  if (!permissions.audio && !permissions.video) return null

  const busy = activeCallId != null
  const disabled = disabledProp || busy
  const title = disabledProp ? disabledReason || "Unavailable" : busy ? "You are already on a call" : undefined

  const iconOnly = size === "icon" && !showLabels

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)} title={title}>
      {permissions.audio && (
        <Button
          type="button"
          size={iconOnly ? "icon" : "sm"}
          variant="outline"
          disabled={disabled}
          onClick={() => startCall("audio", target)}
          aria-label={`Audio call ${target.name || "employee"}`}
        >
          <Phone className="size-4" />
          {showLabels && <span>Call</span>}
        </Button>
      )}
      {permissions.video && (
        <Button
          type="button"
          size={iconOnly ? "icon" : "sm"}
          variant="outline"
          disabled={disabled}
          onClick={() => startCall("video", target)}
          aria-label={`Video call ${target.name || "employee"}`}
        >
          <Video className="size-4" />
          {showLabels && <span>Video</span>}
        </Button>
      )}
    </div>
  )
}

/** A small presence dot for an employee, with an accessible label. */
export function PresenceDot({ status, className }: { status?: PresenceStatus; className?: string }) {
  const meta = PRESENCE_META[status || "offline"]
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("size-2 rounded-full", meta.dot)} aria-hidden />
      <span className="sr-only">{meta.label}</span>
    </span>
  )
}

/**
 * Convenience wrapper: call buttons + a live presence dot for a single
 * employee, self-contained (fetches its own presence). Use where you have one
 * employee row and don't want to batch presence lookups.
 */
export function EmployeeCallAction({
  target,
  showLabels = false,
  showPresence = true,
  disabled,
  disabledReason,
  className,
}: {
  target: CallTargetInput
  showLabels?: boolean
  showPresence?: boolean
  disabled?: boolean
  disabledReason?: string
  className?: string
}) {
  const presence = usePresence(showPresence ? [target.employeeId] : [])
  const status = presence[target.employeeId]
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      {showPresence && <PresenceDot status={status} />}
      <CallButtons target={target} showLabels={showLabels} disabled={disabled} disabledReason={disabledReason} />
    </div>
  )
}
