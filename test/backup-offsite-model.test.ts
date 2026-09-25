import { describe, expect, it } from "vitest"
import {
  DEFAULT_PART_SIZE,
  MIN_PART_SIZE,
  MULTIPART_THRESHOLD,
  TEMP_DB_PREFIX,
  buildObjectKey,
  buildTempDatabaseName,
  classifyArtifactReadFailure,
  classifyUploadError,
  computeRetainUntil,
  describeArtifactReadFailure,
  describeOffsite,
  isDeleteAllowed,
  isSafeIdentifier,
  isSafeTempDatabaseName,
  nextRetryDelayMs,
  partRange,
  planUpload,
  readOffsiteConfig,
  shouldRetryUpload,
  summarizeRecoveryPosture,
  type RecoveryPointLike,
  type RestoreEvidenceLike,
} from "@/lib/backup/offsite-model"

/**
 * Spec10 — pure, DB-free unit tests for the off-site backup / DR model:
 * environment-driven config resolution and redaction, tenant-scoped object
 * keys, immutable-retention math, large-artifact upload planning, interrupted
 * upload classification + backoff, key-loss detection, isolated-restore
 * identifier safety, and measured RPO/RTO posture. Fixed clocks and fixtures
 * keep every assertion deterministic.
 */

describe("readOffsiteConfig / describeOffsite", () => {
  it("is disabled when no target is configured", () => {
    const cfg = readOffsiteConfig({})
    expect(cfg.mode).toBe("disabled")
    expect(cfg.primary).toBeNull()
    expect(cfg.disabledReason).toBeTruthy()
    const status = describeOffsite(cfg)
    expect(status.enabled).toBe(false)
    expect(status.crossRegion).toBe(false)
  })

  it("resolves an S3 target with cross-region replica and immutable defaults", () => {
    const cfg = readOffsiteConfig({
      BACKUP_OFFSITE_BUCKET: "erp-backups",
      BACKUP_OFFSITE_REGION: "eu-central-1",
      BACKUP_OFFSITE_REPLICA_BUCKET: "erp-backups-dr",
      BACKUP_OFFSITE_REPLICA_REGION: "us-west-2",
    })
    expect(cfg.mode).toBe("s3")
    expect(cfg.primary?.bucket).toBe("erp-backups")
    expect(cfg.primary?.region).toBe("eu-central-1")
    expect(cfg.replica?.region).toBe("us-west-2")
    // Immutable retention on by default.
    expect(cfg.immutable).toBe(true)
    expect(cfg.lockMode).toBe("GOVERNANCE")

    const status = describeOffsite(cfg)
    expect(status.crossRegion).toBe(true)
    expect(status.primaryRegion).toBe("eu-central-1")
    expect(status.replicaRegion).toBe("us-west-2")
    // Redacted status never leaks bucket names, endpoints or credentials.
    expect(JSON.stringify(status)).not.toContain("erp-backups")
  })

  it("honours COMPLIANCE lock mode and a clamped immutable floor", () => {
    const cfg = readOffsiteConfig({
      BACKUP_OFFSITE_LOCAL_DIR: "/var/backups",
      BACKUP_OFFSITE_LOCK_MODE: "compliance",
      BACKUP_OFFSITE_MIN_IMMUTABLE_DAYS: "99999",
    })
    expect(cfg.mode).toBe("local")
    expect(cfg.lockMode).toBe("COMPLIANCE")
    expect(cfg.minImmutableDays).toBe(3650) // clamped to the 10-year cap
  })

  it("can explicitly disable immutability", () => {
    const cfg = readOffsiteConfig({ BACKUP_OFFSITE_BUCKET: "b", BACKUP_OFFSITE_IMMUTABLE: "false" })
    expect(cfg.immutable).toBe(false)
  })
})

describe("buildObjectKey (tenant-specific recovery points)", () => {
  it("files each recovery point under its tenant + scope", () => {
    const key = buildObjectKey({
      prefix: "backups",
      tenantId: 42,
      scope: "database",
      runId: 7,
      generatedAt: new Date("2026-03-09T10:00:00.000Z"),
    })
    expect(key).toBe(`backups/tenant-42/database/2026/03/run-7-${Date.parse("2026-03-09T10:00:00.000Z")}.bin.enc`)
  })

  it("uses a platform namespace for baseline (null tenant) and rejects unsafe scope", () => {
    const key = buildObjectKey({
      prefix: "/x/",
      tenantId: null,
      scope: "../etc",
      runId: 1,
      generatedAt: "2026-01-02T00:00:00.000Z",
    })
    expect(key.startsWith("x/platform/unknown/")).toBe(true)
  })

  it("keeps keys unique per run so points never collide", () => {
    const base = { prefix: "b", tenantId: 1, scope: "files", generatedAt: new Date("2026-05-01T00:00:00Z") }
    expect(buildObjectKey({ ...base, runId: 1 })).not.toBe(buildObjectKey({ ...base, runId: 2 }))
  })
})

describe("immutable retention math", () => {
  const created = new Date("2026-01-01T00:00:00.000Z")

  it("retains for the later of policy window and immutable floor", () => {
    // Policy shorter than floor → floor wins.
    const a = computeRetainUntil(created, 3, 30)
    expect(a.toISOString()).toBe("2026-01-31T00:00:00.000Z")
    // Policy longer than floor → policy wins.
    const b = computeRetainUntil(created, 90, 7)
    expect(b.toISOString()).toBe("2026-04-01T00:00:00.000Z")
  })

  it("blocks deletion before retainUntil under immutability, allows after", () => {
    const retainUntil = new Date("2026-02-01T00:00:00.000Z")
    expect(isDeleteAllowed(retainUntil, true, new Date("2026-01-15T00:00:00Z"))).toBe(false)
    expect(isDeleteAllowed(retainUntil, true, new Date("2026-02-02T00:00:00Z"))).toBe(true)
  })

  it("never blocks deletion when immutability is off", () => {
    expect(isDeleteAllowed(new Date("2099-01-01T00:00:00Z"), false, new Date("2026-01-01Z"))).toBe(true)
  })
})

describe("large-artifact upload planning", () => {
  it("uses a single PUT below the multipart threshold", () => {
    const plan = planUpload(1024)
    expect(plan.multipart).toBe(false)
    expect(plan.partCount).toBe(1)
  })

  it("splits a large artifact into >=5MB parts that tile the whole object", () => {
    const total = 100 * 1024 * 1024 // 100 MiB
    const plan = planUpload(total)
    expect(plan.multipart).toBe(true)
    expect(plan.partSize).toBeGreaterThanOrEqual(MIN_PART_SIZE)
    expect(plan.partSize).toBe(DEFAULT_PART_SIZE)
    expect(plan.partCount).toBe(Math.ceil(total / DEFAULT_PART_SIZE))

    // Parts cover [0, total) contiguously with no gaps or overlap.
    let cursor = 0
    for (let i = 1; i <= plan.partCount; i++) {
      const { start, end } = partRange(plan, i)
      expect(start).toBe(cursor)
      expect(end).toBeGreaterThan(start)
      cursor = end
    }
    expect(cursor).toBe(total)
  })

  it("clamps a too-small requested part size up to the S3 minimum", () => {
    const plan = planUpload(MULTIPART_THRESHOLD + 1, 1024)
    expect(plan.partSize).toBe(MIN_PART_SIZE)
  })

  it("plans nothing for an empty artifact", () => {
    expect(planUpload(0).partCount).toBe(0)
  })
})

describe("interrupted-upload classification + backoff", () => {
  it("treats connection resets and 5xx/429 as transient (retryable)", () => {
    expect(classifyUploadError({ code: "ECONNRESET" })).toBe("transient")
    expect(classifyUploadError({ $metadata: { httpStatusCode: 503 } })).toBe("transient")
    expect(classifyUploadError({ $metadata: { httpStatusCode: 429 } })).toBe("transient")
    expect(classifyUploadError({ name: "SlowDown" })).toBe("transient")
  })

  it("treats credential failures as auth (not retryable)", () => {
    expect(classifyUploadError({ name: "AccessDenied" })).toBe("auth")
    expect(classifyUploadError({ $metadata: { httpStatusCode: 403 } })).toBe("auth")
  })

  it("detects object-lock / WORM violations as immutable", () => {
    expect(classifyUploadError({ message: "Object Lock retention period not met" })).toBe("immutable")
  })

  it("only retries transient errors within the attempt budget", () => {
    expect(shouldRetryUpload("transient", 1, 3)).toBe(true)
    expect(shouldRetryUpload("transient", 3, 3)).toBe(false)
    expect(shouldRetryUpload("auth", 1, 3)).toBe(false)
    expect(shouldRetryUpload("fatal", 1, 3)).toBe(false)
  })

  it("backs off exponentially with a hard cap", () => {
    expect(nextRetryDelayMs(1, 200)).toBe(200)
    expect(nextRetryDelayMs(2, 200)).toBe(400)
    expect(nextRetryDelayMs(3, 200)).toBe(800)
    expect(nextRetryDelayMs(20, 200, 5000)).toBe(5000) // capped
  })
})

describe("key-loss handling (restore integrity)", () => {
  it("classifies a GCM auth-tag failure as a key mismatch", () => {
    expect(classifyArtifactReadFailure(new Error("Unsupported state or unable to authenticate data"))).toBe(
      "key_mismatch",
    )
    expect(classifyArtifactReadFailure("bad decrypt")).toBe("key_mismatch")
  })

  it("distinguishes missing objects and corruption from key loss", () => {
    expect(classifyArtifactReadFailure({ message: "NoSuchKey" })).toBe("missing")
    expect(classifyArtifactReadFailure(new Error("Unexpected token in JSON"))).toBe("corrupt")
    expect(classifyArtifactReadFailure(new Error("weird"))).toBe("unknown")
  })

  it("explains each failure in operator-facing language", () => {
    expect(describeArtifactReadFailure("key_mismatch")).toMatch(/encryption key/i)
    expect(describeArtifactReadFailure("missing")).toMatch(/could not be found/i)
  })
})

describe("isolated-restore identifiers", () => {
  it("builds a safe, prefixed, unique temp database name", () => {
    const name = buildTempDatabaseName(7, "AbC-123-XYZ!!")
    expect(name.startsWith(TEMP_DB_PREFIX)).toBe(true)
    expect(isSafeTempDatabaseName(name)).toBe(true)
    expect(name).toMatch(/^mnt_restore_r7_[a-z0-9]+$/)
  })

  it("refuses to treat a real schema as a drill database", () => {
    expect(isSafeTempDatabaseName("muenot_erp")).toBe(false)
    expect(isSafeTempDatabaseName("mnt_restore_; DROP")).toBe(false)
  })

  it("guards identifier interpolation against injection", () => {
    expect(isSafeIdentifier("orders")).toBe(true)
    expect(isSafeIdentifier("users; DROP TABLE")).toBe(false)
    expect(isSafeIdentifier("`x`")).toBe(false)
  })
})

describe("summarizeRecoveryPosture (measured RPO / RTO / evidence)", () => {
  const now = new Date("2026-03-10T12:00:00.000Z")

  it("is not measurable with no completed backups", () => {
    const p = summarizeRecoveryPosture([], [], now)
    expect(p.measurable).toBe(false)
    expect(p.rpoMinutes).toBeNull()
    expect(p.rtoMinutes).toBeNull()
    expect(p.totalCompleted).toBe(0)
  })

  it("measures RPO from the newest completed backup and ignores failed runs", () => {
    const runs: RecoveryPointLike[] = [
      {
        status: "completed",
        createdAt: "2026-03-10T09:00:00.000Z",
        finishedAt: "2026-03-10T09:00:00.000Z",
        verificationStatus: "passed",
        verifiedAt: "2026-03-10T09:05:00.000Z",
        storageLocation: "offsite",
        immutable: true,
        replicaRegion: "us-west-2",
      },
      // A newer run that FAILED must not improve the RPO.
      { status: "failed", createdAt: "2026-03-10T11:30:00.000Z" },
    ]
    const p = summarizeRecoveryPosture(runs, [], now)
    expect(p.measurable).toBe(true)
    expect(p.rpoMinutes).toBe(180) // 3h since the last GOOD backup
    expect(p.latestSuccessfulBackupAt).toBe("2026-03-10T09:00:00.000Z")
    expect(p.lastVerificationStatus).toBe("passed")
    expect(p.offsiteCount).toBe(1)
    expect(p.immutableCount).toBe(1)
    expect(p.crossRegionCount).toBe(1)
    expect(p.totalCompleted).toBe(1)
  })

  it("measures RTO from the most recent PASSED drill and surfaces evidence", () => {
    const drills: RestoreEvidenceLike[] = [
      {
        status: "passed",
        createdAt: "2026-03-09T00:00:00.000Z",
        durationMs: 45_000,
        tempDatabase: "mnt_restore_r1_abc",
        restoredRows: 1200,
        mode: "isolated",
      },
      {
        status: "failed",
        createdAt: "2026-03-10T08:00:00.000Z",
        durationMs: 5_000,
        tempDatabase: "mnt_restore_r2_def",
        restoredRows: 0,
      },
    ]
    const p = summarizeRecoveryPosture([{ status: "completed", createdAt: "2026-03-10T09:00:00Z" }], drills, now)
    // Most recent drill (failed) is the evidence shown...
    expect(p.lastDrillStatus).toBe("failed")
    expect(p.lastDrillTempDatabase).toBe("mnt_restore_r2_def")
    // ...but RTO is measured only from the last PASSED drill.
    expect(p.rtoDurationMs).toBe(45_000)
    expect(p.rtoMinutes).toBe(1) // ceil(45s) => 1 min, min 1 when non-zero
  })
})
