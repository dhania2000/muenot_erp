// ---------------------------------------------------------------------------
// Single source of truth for the attendance "idle grace period".
//
// Continuous inactivity up to this many minutes still counts as Attendance /
// Active Working Time. Only the portion beyond this threshold is counted as
// Break Time (see the formula below). Both the client-side idle tracker and
// any server-side attendance calculations import this constant so they can
// never drift apart — change the value here to retune the grace window (e.g.
// 5, 15, 20 minutes) for the whole app.
//
// This file has no imports and no "use client"/"server-only" markers so it is
// safe to import from both client components and server code.
//
//   Grace Attendance Time = MIN(Idle Duration, IDLE_GRACE_MINUTES)
//   Break Time            = MAX(Idle Duration - IDLE_GRACE_MINUTES, 0)
// ---------------------------------------------------------------------------

export const IDLE_GRACE_MINUTES = 10
export const IDLE_GRACE_MS = IDLE_GRACE_MINUTES * 60 * 1000

/** Live, per-employee activity status shown in the UI while clocked in. */
export type IdleStatus = "active" | "idle" | "break"
