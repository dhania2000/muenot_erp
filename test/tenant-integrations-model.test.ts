import { describe, expect, it } from "vitest"
import { SECRET_EMPTY, SECRET_MASK } from "@/lib/secrets/model"
import {
  type IntegrationState,
  type PublicIntegration,
  type SecretVersionRow,
  TENANT_INTEGRATIONS,
  assertNoTenantSecretExposure,
  decideRollback,
  deriveIdempotencyKey,
  getIntegrationDescriptor,
  isKnownIntegration,
  isValidField,
  nextVersion,
  normalizeVaultChoice,
  toPublicIntegration,
} from "@/lib/secrets/tenant-integrations"

/**
 * Spec 9 — tenant integration secrets PURE model (#20-21, #115-117).
 *
 * A tenant's OWN integration credentials are scoped separately from platform
 * secrets. This module holds the DB-free rules the store + API build on:
 * catalogue integrity, key/field/vault validation, the masked (plaintext-free)
 * projection, rotation/rollback selection, and idempotency-key derivation.
 */

const version = (over: Partial<SecretVersionRow> = {}): SecretVersionRow => ({
  version: 1,
  vaultKind: "db",
  active: false,
  createdAt: "2026-06-01T00:00:00Z",
  retiredAt: null,
  ...over,
})

describe("catalogue integrity", () => {
  it("keys are unique and every field key is well-formed", () => {
    const keys = TENANT_INTEGRATIONS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const i of TENANT_INTEGRATIONS) {
      expect(i.rotationIntervalDays).toBeGreaterThan(0)
      expect(i.fields.length).toBeGreaterThan(0)
      for (const f of i.fields) expect(f.key).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it("lookup helpers agree with the catalogue", () => {
    expect(isKnownIntegration("stripe")).toBe(true)
    expect(isKnownIntegration("not_a_thing")).toBe(false)
    expect(getIntegrationDescriptor("stripe")?.category).toBe("payments")
    expect(getIntegrationDescriptor("nope")).toBeNull()
  })
})

describe("field + vault validation", () => {
  it("known integrations constrain fields to their declared set", () => {
    expect(isValidField("stripe", "secret_key")).toBe(true)
    expect(isValidField("stripe", "webhook_secret")).toBe(true)
    expect(isValidField("stripe", "not_a_field")).toBe(false)
  })

  it("only the custom integration accepts a free-form (well-formed) field", () => {
    expect(isValidField("custom", "my_bespoke_key")).toBe(true)
    expect(isValidField("custom", "Bad Key")).toBe(false)
    expect(isValidField("webhook", "arbitrary")).toBe(false)
  })

  it("normalizeVaultChoice maps blanks/unknowns to null (=auto) and keeps valid kinds", () => {
    expect(normalizeVaultChoice("")).toBeNull()
    expect(normalizeVaultChoice(null)).toBeNull()
    expect(normalizeVaultChoice("gcp")).toBeNull()
    expect(normalizeVaultChoice("aws_secrets_manager")).toBe("aws_secrets_manager")
    expect(normalizeVaultChoice("db")).toBe("db")
  })
})

describe("versions + rollback selection", () => {
  it("nextVersion is max + 1 (or 1 when empty)", () => {
    expect(nextVersion([])).toBe(1)
    expect(nextVersion([version({ version: 1 }), version({ version: 4 })])).toBe(5)
  })

  it("rollback to a prior version reports the currently-active version as fromVersion", () => {
    const rows = [version({ version: 1 }), version({ version: 2, active: true })]
    const d = decideRollback(rows, 1)
    expect(d).toEqual({ ok: true, targetVersion: 1, fromVersion: 2 })
  })

  it("rollback to a non-existent version is rejected", () => {
    const rows = [version({ version: 1, active: true })]
    const d = decideRollback(rows, 9)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/does not exist/)
  })

  it("rollback to the already-active version is rejected (no-op)", () => {
    const rows = [version({ version: 1 }), version({ version: 2, active: true })]
    const d = decideRollback(rows, 2)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/already active/)
  })
})

describe("masked public projection (no plaintext exposure)", () => {
  const descriptor = getIntegrationDescriptor("stripe")!

  const state = (over: Partial<IntegrationState> = {}): IntegrationState => ({
    vaultKind: "db",
    health: "unknown",
    lastTestedAt: null,
    fields: {},
    ...over,
  })

  it("present fields are masked; absent fields read as 'not set'; never a value", () => {
    const pub = toPublicIntegration(
      descriptor,
      state({
        vaultKind: "aws_secrets_manager",
        health: "healthy",
        fields: {
          secret_key: { present: true, version: 3, vaultKind: "aws_secrets_manager", lastRotatedAt: "2026-05-01T00:00:00Z" },
        },
      }),
    )
    const secret = pub.fields.find((f) => f.key === "secret_key")!
    const webhook = pub.fields.find((f) => f.key === "webhook_secret")!
    expect(secret.masked).toBe(SECRET_MASK)
    expect(secret.present).toBe(true)
    expect(secret.version).toBe(3)
    expect(secret.vaultKind).toBe("aws_secrets_manager")
    expect(webhook.masked).toBe(SECRET_EMPTY)
    expect(webhook.present).toBe(false)
    expect("value" in (secret as Record<string, unknown>)).toBe(false)
    expect(pub.vaultLabel).toBe("AWS Secrets Manager")
  })

  it("custom integrations surface tenant-populated fields beyond the declared set", () => {
    const custom = getIntegrationDescriptor("custom")!
    const pub = toPublicIntegration(
      custom,
      state({ fields: { value: { present: true, version: 1, vaultKind: "db", lastRotatedAt: null }, extra: { present: true, version: 1, vaultKind: "db", lastRotatedAt: null } } }),
    )
    expect(pub.fields.map((f) => f.key).sort()).toEqual(["extra", "value"])
  })

  it("assertNoTenantSecretExposure passes clean projections and catches a leak", () => {
    const clean = TENANT_INTEGRATIONS.map((d) => toPublicIntegration(d, state()))
    expect(assertNoTenantSecretExposure(clean)).toBe(true)

    const leaked = [
      {
        ...toPublicIntegration(descriptor, state()),
        fields: [{ key: "secret_key", label: "x", present: true, masked: "sk_live_abc", version: 1, vaultKind: "db", rotationStatus: "ok", lastRotatedAt: null, ageDays: null }],
      },
    ] as unknown as PublicIntegration[]
    expect(() => assertNoTenantSecretExposure(leaked)).toThrow(/leaked a value/)
  })
})

describe("idempotency key derivation", () => {
  it("is deterministic and includes tenant/integration/field/action", () => {
    const a = deriveIdempotencyKey({ tenantId: 7, integrationKey: "stripe", fieldKey: "secret_key", action: "set" })
    const b = deriveIdempotencyKey({ tenantId: 7, integrationKey: "stripe", fieldKey: "secret_key", action: "set" })
    expect(a).toBe(b)
    expect(a).toBe("7:stripe:secret_key:set")
  })

  it("differs across tenants so a key cannot cross tenant boundaries", () => {
    const t7 = deriveIdempotencyKey({ tenantId: 7, integrationKey: "stripe", fieldKey: "secret_key", action: "set", clientKey: "abc" })
    const t8 = deriveIdempotencyKey({ tenantId: 8, integrationKey: "stripe", fieldKey: "secret_key", action: "set", clientKey: "abc" })
    expect(t7).not.toBe(t8)
    expect(t7).toBe("7:stripe:secret_key:set:abc")
  })
})
