/**
 * SPEC 37 — Environment / Configuration management.
 * ---------------------------------------------------------------------------
 * Phase 2 (the service), pure core. This module answers the two questions that
 * make configuration management safe:
 *
 *   1. PRECEDENCE — given a deployment env value, a stored value, and a
 *      registry default, which one wins? A value set at the deployment boundary
 *      (process.env) always overrides a stored value, which overrides the
 *      registry default. That order is the contract every consumer relies on.
 *
 *   2. SECRET EXPOSURE — a secret VALUE must never cross the server boundary.
 *      `toPublicEntry` produces the only shape allowed to leave the server; for
 *      a secret it carries presence and source but a null value and a masked
 *      placeholder — never the plaintext.
 *
 * Pure and dependency-free (no DB, no process.env, no `server-only`) so both
 * rules are unit-tested directly in Phase 4.
 */

import type { ConfigCategory, ConfigDescriptor, ConfigScope } from "./registry"

/** Where a resolved value came from, highest precedence first. */
export type ConfigSource = "env" | "tenant" | "platform" | "default" | "unset"

/** The candidate values from each layer, before precedence is applied. */
export type ConfigLayers = {
  /** Value from process.env[descriptor.envVar]. */
  env?: string | null
  /** Value from the tenant settings store (tenant-scoped descriptors only). */
  tenant?: string | null
  /** Value from the platform config store (platform-scoped descriptors only). */
  platform?: string | null
}

/** Internal resolution result — MAY contain a secret plaintext. Never serialize. */
export type RawResolution = { value: string | null; source: ConfigSource }

/**
 * The public, serialization-safe projection of a resolved config entry. This is
 * the ONLY shape allowed to leave the server. For a secret, `value` is always
 * null and `masked` hides the plaintext.
 */
export type ResolvedConfigEntry = {
  key: string
  label: string
  description: string
  category: ConfigCategory
  scope: ConfigScope
  secret: boolean
  envVar: string | null
  source: ConfigSource
  hasValue: boolean
  /** Null for every secret (always) and for any unset non-secret. */
  value: string | null
  /** Human-facing display string; secrets never reveal plaintext here. */
  masked: string
}

const MASK = "••••••••"
const EMPTY = "not set"

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== ""
}

/**
 * Apply the precedence rule. A descriptor is single-scope, so tenant and
 * platform never compete for the same key — but a deployment env value always
 * wins, and the registry default is the floor.
 */
export function resolveConfigValue(descriptor: ConfigDescriptor, layers: ConfigLayers): RawResolution {
  if (present(layers.env)) return { value: layers.env, source: "env" }
  if (descriptor.scope === "tenant" && present(layers.tenant)) {
    return { value: layers.tenant, source: "tenant" }
  }
  if (descriptor.scope === "platform" && present(layers.platform)) {
    return { value: layers.platform, source: "platform" }
  }
  if (present(descriptor.default)) return { value: descriptor.default, source: "default" }
  return { value: null, source: "unset" }
}

/**
 * Project a raw resolution into the public, secret-safe entry. This is the
 * single chokepoint that strips secret plaintext, so anything rendered or sent
 * to a client goes through here.
 */
export function toPublicEntry(descriptor: ConfigDescriptor, raw: RawResolution): ResolvedConfigEntry {
  const hasValue = present(raw.value)
  return {
    key: descriptor.key,
    label: descriptor.label,
    description: descriptor.description,
    category: descriptor.category,
    scope: descriptor.scope,
    secret: descriptor.secret,
    envVar: descriptor.envVar ?? null,
    source: hasValue ? raw.source : "unset",
    hasValue,
    // A secret NEVER carries a plaintext value across the boundary.
    value: descriptor.secret ? null : hasValue ? raw.value : null,
    masked: descriptor.secret ? (hasValue ? MASK : EMPTY) : hasValue ? (raw.value as string) : EMPTY,
  }
}

/**
 * Defensive assertion used by the service and the test suite: no public entry
 * for a secret descriptor may carry a plaintext value. Returns true when safe,
 * throws with the offending key otherwise.
 */
export function assertNoSecretExposure(entries: ResolvedConfigEntry[]): true {
  for (const e of entries) {
    if (e.secret && e.value !== null) {
      throw new Error(`Secret configuration "${e.key}" exposed a plaintext value`)
    }
    if (e.secret && e.masked !== MASK && e.masked !== EMPTY) {
      throw new Error(`Secret configuration "${e.key}" leaked plaintext through masked display`)
    }
  }
  return true
}
