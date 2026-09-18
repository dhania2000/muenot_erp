/**
 * SPEC 38 — Secret management. Pure domain core.
 * ---------------------------------------------------------------------------
 * The three rules a secret manager lives or dies by, all pure and dependency
 * free (no DB, no process.env, no `server-only`) so Phase 4 exercises them
 * directly:
 *
 *   1. MASKING / NO FRONTEND EXPOSURE — a secret plaintext must never cross the
 *      server boundary. `toPublicSecret` is the ONLY projection allowed to leave
 *      the server; it carries presence, source and metadata but never a value,
 *      and `assertNoPlaintextExposure` fails closed if a regression forgets.
 *
 *   2. ROTATION — given when a secret was last rotated and its policy interval,
 *      `rotationStatus` classifies it as never / ok / due / overdue so operators
 *      can act before a credential goes stale.
 *
 *   3. AUDIT — `shapeAuditEvent` normalises an access-log row into a stable,
 *      serialisation-safe shape for the console.
 */

import type { SecretCategory, SecretDescriptor } from "./inventory"

/** Where the effective secret value comes from. Env always wins over stored. */
export type SecretSource = "env" | "stored" | "unset"

/** Rotation health derived from the last rotation and the policy interval. */
export type RotationStatus = "never" | "ok" | "due" | "overdue"

/** Actions recorded in the access audit. */
export const SECRET_ACTIONS = ["create", "update", "rotate", "clear", "access", "view"] as const
export type SecretAction = (typeof SECRET_ACTIONS)[number]

/**
 * The public, serialisation-safe projection of a secret. This is the ONLY shape
 * allowed to leave the server. It deliberately has NO `value` field — there is
 * no property a plaintext could ever be attached to.
 */
export type PublicSecret = {
  key: string
  label: string
  description: string
  category: SecretCategory
  envVar: string
  critical: boolean
  source: SecretSource
  /** True when a value exists at the env boundary OR in the encrypted store. */
  present: boolean
  /** Always the fixed mask for a present secret, the empty marker otherwise. */
  masked: string
  /** Whether an encrypted value is held in the managed store (vs env-only). */
  stored: boolean
  /** Active stored version number (0 when nothing is stored). */
  version: number
  /** Short, non-reversible fingerprint of the master key at write time. */
  keyFingerprint: string | null
  rotationIntervalDays: number
  rotationStatus: RotationStatus
  /** Whole days since the last rotation, or null when never rotated. */
  ageDays: number | null
  lastRotatedAt: string | null
  updatedAt: string | null
  lastAccessedAt: string | null
}

/** The stored/runtime state the store feeds into the projection. */
export type SecretState = {
  /** Value present at the deployment env boundary. */
  envPresent: boolean
  /** Encrypted value held in the managed store. */
  stored: boolean
  version: number
  keyFingerprint: string | null
  lastRotatedAt: string | null
  updatedAt: string | null
  lastAccessedAt: string | null
}

export const SECRET_MASK = "••••••••"
export const SECRET_EMPTY = "not set"
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Mask a value for display. There is intentionally NO option to reveal any
 * character of the plaintext — the requirement is no frontend exposure, so the
 * mask is fixed and independent of the value's content or length.
 */
export function maskSecret(present: boolean): string {
  return present ? SECRET_MASK : SECRET_EMPTY
}

/** Whole days between two instants (floored, never negative). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

/**
 * Classify rotation health. A secret that has never been rotated through the
 * manager is "never"; once it has, it is overdue at/after the interval, "due"
 * inside the final 10% of the window, and "ok" before that.
 */
export function rotationStatus(
  lastRotatedAt: string | null,
  intervalDays: number,
  now: Date = new Date(),
): RotationStatus {
  if (!lastRotatedAt) return "never"
  const last = new Date(lastRotatedAt)
  if (Number.isNaN(last.getTime())) return "never"
  const age = daysBetween(last, now)
  if (age >= intervalDays) return "overdue"
  if (age >= Math.floor(intervalDays * 0.9)) return "due"
  return "ok"
}

/**
 * Project a descriptor + state into the public, plaintext-free shape. Source
 * precedence mirrors the config service: an env value outranks a stored one.
 */
export function toPublicSecret(
  descriptor: SecretDescriptor,
  state: SecretState,
  now: Date = new Date(),
): PublicSecret {
  const present = state.envPresent || state.stored
  const source: SecretSource = state.envPresent ? "env" : state.stored ? "stored" : "unset"
  const last = state.lastRotatedAt
  return {
    key: descriptor.key,
    label: descriptor.label,
    description: descriptor.description,
    category: descriptor.category,
    envVar: descriptor.envVar,
    critical: descriptor.critical,
    source,
    present,
    masked: maskSecret(present),
    stored: state.stored,
    version: state.version,
    keyFingerprint: state.keyFingerprint,
    rotationIntervalDays: descriptor.rotationIntervalDays,
    rotationStatus: rotationStatus(last, descriptor.rotationIntervalDays, now),
    ageDays: last ? daysBetween(new Date(last), now) : null,
    lastRotatedAt: last,
    updatedAt: state.updatedAt,
    lastAccessedAt: state.lastAccessedAt,
  }
}

/**
 * Fail-closed invariant used by the API and the test suite: no public secret
 * may carry anything but the fixed mask or empty marker, and the shape must not
 * have grown a value-bearing field. Returns true when safe, throws otherwise.
 */
export function assertNoPlaintextExposure(secrets: PublicSecret[]): true {
  for (const s of secrets) {
    if (s.masked !== SECRET_MASK && s.masked !== SECRET_EMPTY) {
      throw new Error(`Secret "${s.key}" leaked a value through its masked display`)
    }
    if ("value" in (s as Record<string, unknown>)) {
      throw new Error(`Secret "${s.key}" exposed a plaintext value field`)
    }
  }
  return true
}

export type PublicAuditEvent = {
  id: number
  secretKey: string
  action: SecretAction
  actorEmail: string | null
  detail: string | null
  at: string
}

/** Normalise a raw access-log row into the serialisation-safe console shape. */
export function shapeAuditEvent(row: {
  id: number | string
  secret_key: string
  action: string
  actor_email?: string | null
  detail?: string | null
  created_at: string
}): PublicAuditEvent {
  const action = (SECRET_ACTIONS as readonly string[]).includes(row.action)
    ? (row.action as SecretAction)
    : "access"
  return {
    id: Number(row.id),
    secretKey: row.secret_key,
    action,
    actorEmail: row.actor_email ?? null,
    detail: row.detail ?? null,
    at: row.created_at,
  }
}
