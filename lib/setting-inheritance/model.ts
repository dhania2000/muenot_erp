/**
 * SPEC 40 — Configuration inheritance: pure precedence engine.
 * ---------------------------------------------------------------------------
 * No DB, no `server-only`. Encodes the ONE rule the feature exists for: an
 * effective setting value is resolved by walking the org hierarchy from the
 * narrowest scope that set it outward to the broadest, and finally the
 * registry default:
 *
 *   env  >  user  >  department  >  branch  >  company  >  global  >  default
 *
 * The store (store.ts) only loads the raw overrides for a context and calls
 * {@link resolveInherited}; every override/precedence decision lives here so it
 * is unit-tested without a database (see test/spec40-config-inheritance.test.ts).
 */

import type { PolicyField } from "./policies"

/** Org-hierarchy scope levels, ordered BROADEST → NARROWEST. */
export const SCOPE_LEVELS = ["global", "company", "branch", "department", "user"] as const
export type ScopeLevel = (typeof SCOPE_LEVELS)[number]

/**
 * Resolution order, NARROWEST → BROADEST. The first level that both holds a
 * value AND is allowed to override wins (after an env override, before default).
 */
export const RESOLUTION_ORDER: readonly ScopeLevel[] = ["user", "department", "branch", "company", "global"] as const

export function isScopeLevel(v: unknown): v is ScopeLevel {
  return typeof v === "string" && (SCOPE_LEVELS as readonly string[]).includes(v)
}

/** The scope id semantics per level: null/0 for global, an org-unit id for
 *  company/branch/department, a user id for user. */
export type OverrideLayer = {
  level: ScopeLevel
  scopeId: number | null
  value: string | null
}

export type InheritSource = "env" | ScopeLevel | "default" | "unset"

export type InheritTraceEntry = {
  level: ScopeLevel
  scopeId: number | null
  /** Raw stored value at this level (null when nothing was stored). */
  value: string | null
  present: boolean
  /** True for the single winning layer. */
  applied: boolean
  /** Present but disregarded because the field forbids overrides at this level. */
  ignoredReason?: "not_overridable"
}

export type InheritResolution = {
  key: string
  value: string | null
  source: InheritSource
  /** Broadest → narrowest, so a UI can render the inheritance chain top-down. */
  trace: InheritTraceEntry[]
}

/** A layer value counts as "present" only when it is a non-blank string. */
function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Resolve a field's effective value from the raw override layers plus an
 * optional deployment env override.
 *
 * `layers` may contain at most one entry per level; extra/duplicate or
 * unknown-level entries are ignored defensively. A layer at a level the field
 * does not allow to override is recorded in the trace as `not_overridable` and
 * never wins — this is what keeps a company-pinned security policy from being
 * relaxed per-user.
 */
export function resolveInherited(
  field: PolicyField,
  layers: OverrideLayer[],
  opts: { env?: string | null } = {},
): InheritResolution {
  const allowed = new Set(field.overridableLevels)
  const byLevel = new Map<ScopeLevel, OverrideLayer>()
  for (const layer of layers) {
    if (!isScopeLevel(layer.level)) continue
    if (!byLevel.has(layer.level)) byLevel.set(layer.level, layer)
  }

  // Determine the winning level (narrowest present + overridable), env aside.
  let winningLevel: ScopeLevel | null = null
  for (const level of RESOLUTION_ORDER) {
    const layer = byLevel.get(level)
    if (layer && isPresent(layer.value) && allowed.has(level)) {
      winningLevel = level
      break
    }
  }

  const envPresent = isPresent(opts.env)

  // Build the trace broadest → narrowest for display.
  const trace: InheritTraceEntry[] = SCOPE_LEVELS.map((level) => {
    const layer = byLevel.get(level)
    const present = !!layer && isPresent(layer.value)
    const notOverridable = present && !allowed.has(level)
    return {
      level,
      scopeId: layer?.scopeId ?? null,
      value: layer ? layer.value : null,
      present,
      applied: !envPresent && winningLevel === level,
      ...(notOverridable ? { ignoredReason: "not_overridable" as const } : {}),
    }
  })

  if (envPresent) {
    return { key: field.key, value: opts.env!.trim(), source: "env", trace }
  }
  if (winningLevel) {
    return { key: field.key, value: byLevel.get(winningLevel)!.value!.trim(), source: winningLevel, trace }
  }
  if (isPresent(field.default)) {
    return { key: field.key, value: field.default, source: "default", trace }
  }
  return { key: field.key, value: field.default === "" ? "" : null, source: field.default === "" ? "default" : "unset", trace }
}

/**
 * Whether `level` is permitted to store an override for `field`. Callers MUST
 * gate writes on this so an override can never be persisted at an illegal level
 * (which would silently never take effect, or worse, be resurrected later).
 */
export function canOverrideAt(field: PolicyField, level: ScopeLevel): boolean {
  return field.overridableLevels.includes(level)
}

/** Coerce/validate a raw string value against a field's declared type. Returns
 *  the normalised string to store, or an error describing why it was rejected. */
export function validatePolicyValue(
  field: PolicyField,
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw == null) return { ok: false, error: "A value is required." }
  const value = String(raw).trim()
  switch (field.type) {
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, error: `${field.label} must be a number.` }
      if (Number(value) < 0) return { ok: false, error: `${field.label} cannot be negative.` }
      return { ok: true, value }
    }
    case "toggle": {
      const v = value.toLowerCase()
      if (v === "true" || v === "1" || v === "yes") return { ok: true, value: "true" }
      if (v === "false" || v === "0" || v === "no") return { ok: true, value: "false" }
      return { ok: false, error: `${field.label} must be true or false.` }
    }
    case "select": {
      if (!field.options?.includes(value)) return { ok: false, error: `${field.label} must be one of: ${field.options?.join(", ")}.` }
      return { ok: true, value }
    }
    case "text":
    default:
      if (value.length > 2000) return { ok: false, error: `${field.label} is too long.` }
      return { ok: true, value }
  }
}

/** The masked projection of a resolved value, so a secret is never rendered. */
export function maskResolved(field: PolicyField, res: InheritResolution): InheritResolution & { masked: string } {
  if (!field.secret) return { ...res, masked: res.value ?? "not set" }
  const hasValue = isPresent(res.value)
  return {
    ...res,
    value: null,
    trace: res.trace.map((t) => ({ ...t, value: t.present ? "••••••••" : t.value })),
    masked: hasValue ? "••••••••" : "not set",
  }
}
