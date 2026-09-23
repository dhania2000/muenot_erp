import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  SECRET_INVENTORY,
  SECRET_CATEGORIES,
  getSecretDescriptor,
  isKnownSecret,
} from "@/lib/secrets/inventory"
import {
  assertNoPlaintextExposure,
  maskSecret,
  rotationStatus,
  shapeAuditEvent,
  toPublicSecret,
  SECRET_MASK,
  SECRET_EMPTY,
  type PublicSecret,
  type SecretState,
} from "@/lib/secrets/model"
import { decryptSecret, encryptSecret, isEncryptionConfigured, keyFingerprint } from "@/lib/secrets/crypto"

/**
 * Phase 4. Security testing.
 *
 * The secret manager is only trustworthy if four invariants hold:
 *   (1) the inventory is well-formed and covers every secret class;
 *   (2) a plaintext NEVER crosses the public projection (masking / no exposure);
 *   (3) rotation health is classified correctly against the policy interval;
 *   (4) encryption at rest round-trips and is tamper-evident.
 * Each block frames the second as an attempted LEAK.
 */

const state = (over: Partial<SecretState> = {}): SecretState => ({
  envPresent: false,
  stored: false,
  version: 0,
  keyFingerprint: null,
  lastRotatedAt: null,
  updatedAt: null,
  lastAccessedAt: null,
  ...over,
})

describe("inventory integrity", () => {
  it("every descriptor uses a known category and mirrors its env var", () => {
    for (const d of SECRET_INVENTORY) {
      expect(SECRET_CATEGORIES).toContain(d.category)
      expect(d.envVar).toBe(d.key)
      expect(d.rotationIntervalDays).toBeGreaterThan(0)
    }
  })

  it("secret keys are unique", () => {
    const keys = SECRET_INVENTORY.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("all seven secret classes are represented", () => {
    const present = new Set(SECRET_INVENTORY.map((d) => d.category))
    for (const c of SECRET_CATEGORIES) expect(present.has(c)).toBe(true)
  })

  it("lookup helpers agree with the catalogue", () => {
    expect(isKnownSecret("STRIPE_SECRET_KEY")).toBe(true)
    expect(isKnownSecret("NOT_A_SECRET")).toBe(false)
    expect(getSecretDescriptor("STRIPE_SECRET_KEY")?.category).toBe("payment_secret")
  })
})

describe("masking and no-frontend-exposure", () => {
  const descriptor = getSecretDescriptor("STRIPE_SECRET_KEY")!

  it("mask is fixed and reveals nothing about the value or its length", () => {
    expect(maskSecret(true)).toBe(SECRET_MASK)
    expect(maskSecret(false)).toBe(SECRET_EMPTY)
  })

  it("the public projection has no value field, whatever the source", () => {
    const stored = toPublicSecret(descriptor, state({ stored: true, version: 3 }))
    expect(stored.source).toBe("stored")
    expect(stored.present).toBe(true)
    expect(stored.masked).toBe(SECRET_MASK)
    expect("value" in (stored as Record<string, unknown>)).toBe(false)

    const env = toPublicSecret(descriptor, state({ envPresent: true }))
    expect(env.source).toBe("env")
    expect(env.masked).toBe(SECRET_MASK)
  })

  it("env presence outranks a stored value as the reported source", () => {
    const both = toPublicSecret(descriptor, state({ envPresent: true, stored: true, version: 2 }))
    expect(both.source).toBe("env")
    expect(both.present).toBe(true)
  })

  it("an unset secret reports not-set without inventing a value", () => {
    const unset = toPublicSecret(descriptor, state())
    expect(unset.present).toBe(false)
    expect(unset.source).toBe("unset")
    expect(unset.masked).toBe(SECRET_EMPTY)
  })

  it("assertNoPlaintextExposure passes for a fully projected inventory", () => {
    const secrets = SECRET_INVENTORY.map((d) => toPublicSecret(d, state({ stored: true, version: 1 })))
    expect(assertNoPlaintextExposure(secrets)).toBe(true)
  })

  it("assertNoPlaintextExposure throws if a masked field leaks a plaintext", () => {
    const tampered = {
      ...toPublicSecret(descriptor, state({ stored: true, version: 1 })),
      masked: "sk_live_abc123",
    } as PublicSecret
    expect(() => assertNoPlaintextExposure([tampered])).toThrow(/leaked a value/)
  })

  it("assertNoPlaintextExposure throws if a value field is ever attached", () => {
    const leaked = {
      ...toPublicSecret(descriptor, state({ stored: true, version: 1 })),
      value: "sk_live_abc123",
    } as unknown as PublicSecret
    expect(() => assertNoPlaintextExposure([leaked])).toThrow(/exposed a plaintext value field/)
  })
})

describe("rotation status", () => {
  const now = new Date("2026-06-01T00:00:00Z")
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

  it("is 'never' when there is no rotation timestamp", () => {
    expect(rotationStatus(null, 90, now)).toBe("never")
    expect(rotationStatus("not-a-date", 90, now)).toBe("never")
  })

  it("is 'ok' well inside the window", () => {
    expect(rotationStatus(daysAgo(10), 90, now)).toBe("ok")
  })

  it("is 'due' in the final 10% of the window", () => {
    expect(rotationStatus(daysAgo(85), 90, now)).toBe("due")
  })

  it("is 'overdue' at or past the interval", () => {
    expect(rotationStatus(daysAgo(90), 90, now)).toBe("overdue")
    expect(rotationStatus(daysAgo(400), 90, now)).toBe("overdue")
  })

  it("surfaces through the projection with the computed age", () => {
    const descriptor = getSecretDescriptor("SESSION_SECRET")! // 90-day policy
    const p = toPublicSecret(descriptor, state({ stored: true, version: 1, lastRotatedAt: daysAgo(120) }), now)
    expect(p.rotationStatus).toBe("overdue")
    expect(p.ageDays).toBe(120)
  })
})

describe("audit event shaping", () => {
  it("normalises a raw row and defaults an unknown action to 'access'", () => {
    const ev = shapeAuditEvent({
      id: "7",
      secret_key: "CRON_SECRET",
      action: "rotate",
      actor_email: "ops@muenot.com",
      detail: "version 2",
      created_at: "2026-06-01T00:00:00Z",
    })
    expect(ev).toEqual({
      id: 7,
      secretKey: "CRON_SECRET",
      action: "rotate",
      actorEmail: "ops@muenot.com",
      detail: "version 2",
      at: "2026-06-01T00:00:00Z",
    })
    expect(shapeAuditEvent({ id: 1, secret_key: "X", action: "weird", created_at: "t" }).action).toBe("access")
  })
})

describe("encryption at rest (AES-256-GCM envelope)", () => {
  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = "unit-test-master-key"
  })
  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
  })

  it("round-trips a value and never stores the plaintext in the envelope", () => {
    const plaintext = "sk_live_51NabcDEF"
    const envelope = encryptSecret(plaintext)
    expect(envelope.startsWith("sec:v1:")).toBe(true)
    expect(envelope).not.toContain(plaintext)
    expect(decryptSecret(envelope)).toBe(plaintext)
  })

  it("produces a distinct ciphertext each time (random IV)", () => {
    expect(encryptSecret("same-value")).not.toBe(encryptSecret("same-value"))
  })

  it("is tamper-evident — a mutated envelope fails to decrypt", () => {
    const envelope = encryptSecret("top-secret")
    // Flip an actual payload character. Changing padding-adjacent characters
    // can accidentally leave the decoded bytes unchanged for some values.
    const index = "sec:v1:".length
    const flipped = envelope.slice(0, index) + (envelope[index] === "A" ? "B" : "A") + envelope.slice(index + 1)
    expect(decryptSecret(flipped)).toBeNull()
  })

  it("cannot be decrypted under a different master key", () => {
    const envelope = encryptSecret("top-secret")
    process.env.SETTINGS_ENCRYPTION_KEY = "a-different-master-key"
    expect(decryptSecret(envelope)).toBeNull()
  })

  it("refuses to encrypt an empty value", () => {
    expect(() => encryptSecret("")).toThrow(/empty/)
  })

  it("exposes a non-reversible key fingerprint, not the key", () => {
    const fp = keyFingerprint()
    expect(fp).toHaveLength(12)
    expect(fp).not.toContain("unit-test-master-key")
    expect(isEncryptionConfigured()).toBe(true)
  })

  it("returns null (not a throw) for a non-envelope value", () => {
    expect(decryptSecret("plain")).toBeNull()
    expect(decryptSecret(null)).toBeNull()
  })
})
