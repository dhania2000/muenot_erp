import { describe, expect, it } from "vitest"

/**
 * Spec7 — Customer-owned S3 IAM access (#14-15): pure credential/policy logic.
 *
 * Covers ARN/ExternalId validation, per-mode credential validation, the
 * tenant-scoped AssumeRole session policy (cross-tenant key guessing is denied
 * by AWS itself), the customer-facing trust/permission templates, safe
 * provider-error logging, AssumeRole failure classification ("incorrect role"),
 * activation gating and presigned-URL expiry clamping.
 */

import {
  buildIamPolicyTemplates,
  buildScopedSessionPolicy,
  classifyAssumeRoleError,
  clampTtlToCredentialExpiry,
  evaluateActivation,
  expectedBucketOwnerFor,
  generateExternalId,
  isValidExternalId,
  isValidRoleArn,
  maskSecret,
  normalizeAuthMode,
  normalizeBucketRegion,
  parseRoleArn,
  redactConnectionForLog,
  sanitizeProviderMessage,
  tenantObjectPrefix,
  validateAuthCredentials,
} from "@/lib/storage/credentials"

describe("auth mode normalization", () => {
  it("defaults unknown values to access_key", () => {
    expect(normalizeAuthMode(undefined)).toBe("access_key")
    expect(normalizeAuthMode(null)).toBe("access_key")
    expect(normalizeAuthMode("nonsense")).toBe("access_key")
    expect(normalizeAuthMode("iam_role")).toBe("iam_role")
    expect(normalizeAuthMode("temporary")).toBe("temporary")
  })
})

describe("parseRoleArn / isValidRoleArn", () => {
  it("parses a well-formed role ARN", () => {
    const parsed = parseRoleArn("arn:aws:iam::123456789012:role/muenot-storage")
    expect(parsed).toEqual({ partition: "aws", accountId: "123456789012", roleName: "muenot-storage" })
  })

  it("accepts gov/cn partitions and pathful role names", () => {
    expect(parseRoleArn("arn:aws-us-gov:iam::123456789012:role/team/app")?.partition).toBe("aws-us-gov")
    expect(parseRoleArn("arn:aws-cn:iam::123456789012:role/x")?.partition).toBe("aws-cn")
  })

  it("rejects non-role ARNs, wrong service, and bad account ids", () => {
    expect(parseRoleArn("arn:aws:iam::123456789012:user/bob")).toBeNull()
    expect(parseRoleArn("arn:aws:s3:::my-bucket")).toBeNull()
    expect(parseRoleArn("arn:aws:iam::12345:role/x")).toBeNull() // account too short
    expect(parseRoleArn("not-an-arn")).toBeNull()
    expect(parseRoleArn(null)).toBeNull()
    expect(isValidRoleArn("arn:aws:iam::123456789012:role/ok")).toBe(true)
    expect(isValidRoleArn("")).toBe(false)
  })
})

describe("isValidExternalId", () => {
  it("accepts the AWS charset within length bounds and rejects the rest", () => {
    expect(isValidExternalId("muenot-abc123")).toBe(true)
    expect(isValidExternalId("a")).toBe(false) // too short
    expect(isValidExternalId("has space")).toBe(false)
    expect(isValidExternalId("x".repeat(1225))).toBe(false) // too long
  })
})

describe("validateAuthCredentials", () => {
  it("requires key + secret for access_key", () => {
    expect(validateAuthCredentials({ provider: "aws_s3", authMode: "access_key", accessKeyId: "", secretAccessKey: "s" }))
      .toMatch(/access key id/i)
    expect(
      validateAuthCredentials({ provider: "aws_s3", authMode: "access_key", accessKeyId: "AKIA", secretAccessKey: "" }),
    ).toMatch(/secret access key/i)
    expect(
      validateAuthCredentials({ provider: "aws_s3", authMode: "access_key", accessKeyId: "AKIA", secretAccessKey: "s" }),
    ).toBeNull()
  })

  it("honours a stored secret when editing (blank secret field)", () => {
    expect(
      validateAuthCredentials({
        provider: "aws_s3",
        authMode: "access_key",
        accessKeyId: "AKIA",
        secretAccessKey: "",
        hasStoredSecret: true,
      }),
    ).toBeNull()
  })

  it("requires a session token for temporary credentials", () => {
    expect(
      validateAuthCredentials({
        provider: "aws_s3",
        authMode: "temporary",
        accessKeyId: "ASIA",
        secretAccessKey: "s",
        sessionToken: "",
      }),
    ).toMatch(/session token/i)
    expect(
      validateAuthCredentials({
        provider: "aws_s3",
        authMode: "temporary",
        accessKeyId: "ASIA",
        secretAccessKey: "s",
        sessionToken: "tok",
      }),
    ).toBeNull()
  })

  it("gates iam_role behind AWS S3 and a valid ARN", () => {
    expect(validateAuthCredentials({ provider: "cloudflare_r2", authMode: "iam_role", roleArn: "arn:aws:iam::123456789012:role/x" }))
      .toMatch(/only supported for amazon s3/i)
    expect(validateAuthCredentials({ provider: "aws_s3", authMode: "iam_role", roleArn: "" })).toMatch(/role arn is required/i)
    expect(validateAuthCredentials({ provider: "aws_s3", authMode: "iam_role", roleArn: "arn:aws:iam::12345:role/x" }))
      .toMatch(/not a valid iam role arn/i)
    expect(
      validateAuthCredentials({
        provider: "aws_s3",
        authMode: "iam_role",
        roleArn: "arn:aws:iam::123456789012:role/muenot",
        externalId: "bad id with spaces",
      }),
    ).toMatch(/external id/i)
    expect(
      validateAuthCredentials({
        provider: "aws_s3",
        authMode: "iam_role",
        roleArn: "arn:aws:iam::123456789012:role/muenot",
      }),
    ).toBeNull()
  })
})

describe("buildScopedSessionPolicy (tenant isolation + least privilege)", () => {
  it("confines every object action to the tenant's own prefix", () => {
    const policy = JSON.parse(
      buildScopedSessionPolicy({ bucket: "cust-bucket", pathPrefix: "erp/prod", tenantId: 42 }),
    )
    const objectStmt = policy.Statement.find((s: any) => s.Sid === "TenantObjects")
    expect(objectStmt.Resource).toBe("arn:aws:s3:::cust-bucket/erp/prod/t/42/*")
    // A guessed key for another tenant is outside the granted resource.
    expect(objectStmt.Resource).not.toContain("t/43/")
    const listStmt = policy.Statement.find((s: any) => s.Sid === "TenantList")
    expect(listStmt.Condition.StringLike["s3:prefix"]).toEqual(["erp/prod/t/42/*"])
  })

  it("uses the role's partition for the bucket ARN", () => {
    const policy = JSON.parse(buildScopedSessionPolicy({ bucket: "b", tenantId: 1, partition: "aws-cn" }))
    expect(policy.Statement[0].Resource.startsWith("arn:aws-cn:s3:::b/")).toBe(true)
  })
})

describe("tenantObjectPrefix", () => {
  it("joins the connection prefix with the tenant namespace", () => {
    expect(tenantObjectPrefix("erp/prod", 7)).toBe("erp/prod/t/7/")
    expect(tenantObjectPrefix(null, 7)).toBe("t/7/")
    expect(tenantObjectPrefix("/leading/", 7)).toBe("leading/t/7/")
  })
})

describe("buildIamPolicyTemplates", () => {
  it("pins the platform principal and the external id in the trust policy", () => {
    const { trustPolicy, permissionPolicy } = buildIamPolicyTemplates({
      platformPrincipalArn: "arn:aws:iam::999999999999:role/platform",
      externalId: "muenot-secret",
      bucket: "cust-bucket",
      pathPrefix: "erp",
    })
    const trust = JSON.parse(trustPolicy)
    expect(trust.Statement[0].Principal.AWS).toBe("arn:aws:iam::999999999999:role/platform")
    expect(trust.Statement[0].Condition.StringEquals["sts:ExternalId"]).toBe("muenot-secret")
    const perm = JSON.parse(permissionPolicy)
    expect(perm.Statement[0].Resource).toContain("cust-bucket/erp/t/*")
  })

  it("falls back to placeholders when principal/externalId are absent", () => {
    const { trustPolicy } = buildIamPolicyTemplates({
      platformPrincipalArn: null,
      externalId: null,
      bucket: "b",
    })
    const trust = JSON.parse(trustPolicy)
    expect(trust.Statement[0].Principal.AWS).toBe("<platform-principal-arn>")
    expect(trust.Statement[0].Condition.StringEquals["sts:ExternalId"]).toBe("<external-id>")
  })
})

describe("generateExternalId", () => {
  it("is prefixed, well-formed and unique per call", () => {
    const a = generateExternalId()
    const b = generateExternalId()
    expect(a).toMatch(/^muenot-[0-9a-f]{36}$/)
    expect(a).not.toBe(b)
    expect(isValidExternalId(a)).toBe(true)
  })
})

describe("sanitizeProviderMessage (safe connection-test logging)", () => {
  it("redacts access key ids, signatures and long secrets", () => {
    const raw =
      "AccessDenied for AKIAIOSFODNN7EXAMPLE with X-Amz-Signature=deadbeefdeadbeefdeadbeef and Credential=AKIAIOSFODNN7EXAMPLE/20260925/us-east-1/s3/aws4_request"
    const out = sanitizeProviderMessage(raw)
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(out).not.toContain("deadbeef")
    expect(out).toContain("[redacted]")
  })

  it("collapses whitespace and clamps length", () => {
    expect(sanitizeProviderMessage("a\n\n   b")).toBe("a b")
    expect(sanitizeProviderMessage("x".repeat(500)).length).toBeLessThanOrEqual(240)
  })
})

describe("maskSecret / redactConnectionForLog", () => {
  it("masks key material and never echoes secrets", () => {
    expect(maskSecret("AKIAIOSFODNN7EXAMPLE")).toMatch(/^AKIA\*+MPLE$/)
    expect(maskSecret("short")).toBe("****")
    expect(maskSecret(null)).toBeNull()
    const redacted = redactConnectionForLog({
      provider: "aws_s3",
      authMode: "iam_role",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "super-secret-value",
      sessionToken: "tok",
      externalId: "muenot-secret",
      roleArn: "arn:aws:iam::123456789012:role/x",
    })
    expect(redacted.secretAccessKey).toBe("***redacted***")
    expect(redacted.sessionToken).toBe("***redacted***")
    expect(redacted.externalId).toBe("***redacted***")
    expect(redacted.roleArn).toBe("arn:aws:iam::123456789012:role/x")
  })
})

describe("classifyAssumeRoleError (incorrect-role diagnostics)", () => {
  it("maps AccessDenied to trust_denied with an actionable message", () => {
    const r = classifyAssumeRoleError({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
    expect(r.code).toBe("trust_denied")
    expect(r.message).toMatch(/trust policy/i)
  })

  it("maps a bare 403 to trust_denied", () => {
    expect(classifyAssumeRoleError({ $metadata: { httpStatusCode: 403 } }).code).toBe("trust_denied")
  })

  it("maps validation/policy errors to role_invalid", () => {
    expect(classifyAssumeRoleError({ name: "MalformedPolicyDocument" }).code).toBe("role_invalid")
    expect(classifyAssumeRoleError({ name: "ValidationError" }).code).toBe("role_invalid")
  })

  it("maps missing/invalid platform principal", () => {
    expect(classifyAssumeRoleError({ name: "CredentialsProviderError" }).code).toBe("platform_principal_missing")
    expect(classifyAssumeRoleError({ name: "InvalidClientTokenId" }).code).toBe("platform_principal_invalid")
  })

  it("maps network and throttling failures", () => {
    expect(classifyAssumeRoleError({ name: "NetworkingError" }).code).toBe("network")
    expect(classifyAssumeRoleError({ message: "ETIMEDOUT" }).code).toBe("network")
    expect(classifyAssumeRoleError({ name: "ThrottlingException" }).code).toBe("throttled")
    expect(classifyAssumeRoleError({ name: "Whatever" }).code).toBe("unknown")
  })
})

describe("normalizeBucketRegion", () => {
  it("maps empty/EU location constraints", () => {
    expect(normalizeBucketRegion(null)).toBe("us-east-1")
    expect(normalizeBucketRegion("")).toBe("us-east-1")
    expect(normalizeBucketRegion("EU")).toBe("eu-west-1")
    expect(normalizeBucketRegion("ap-south-1")).toBe("ap-south-1")
  })
})

describe("expectedBucketOwnerFor", () => {
  it("prefers an explicit 12-digit account", () => {
    expect(expectedBucketOwnerFor({ expectedBucketOwner: "123456789012" })).toBe("123456789012")
  })
  it("falls back to the role account for iam_role", () => {
    expect(
      expectedBucketOwnerFor({ authMode: "iam_role", roleArn: "arn:aws:iam::210987654321:role/x" }),
    ).toBe("210987654321")
  })
  it("returns null for static keys with no explicit owner", () => {
    expect(expectedBucketOwnerFor({ authMode: "access_key" })).toBeNull()
    expect(expectedBucketOwnerFor({ expectedBucketOwner: "bad" })).toBeNull()
  })
})

describe("evaluateActivation (gate before going live)", () => {
  const base = {
    provider: "aws_s3",
    authMode: "iam_role" as const,
    verificationStatus: "verified",
    verifiedFingerprint: "fp",
    currentFingerprint: "fp",
  }

  it("allows a verified, current, non-revoked connection", () => {
    expect(evaluateActivation(base).allowed).toBe(true)
  })

  it("refuses when revoked", () => {
    const r = evaluateActivation({ ...base, revokedAt: new Date().toISOString() })
    expect(r).toMatchObject({ allowed: false, code: "revoked" })
  })

  it("refuses when unverified or failed", () => {
    expect(evaluateActivation({ ...base, verificationStatus: "unverified" })).toMatchObject({ code: "unverified" })
    expect(evaluateActivation({ ...base, verificationStatus: "failed" })).toMatchObject({ code: "failed" })
  })

  it("refuses when the config changed since verification (stale fingerprint)", () => {
    expect(evaluateActivation({ ...base, verifiedFingerprint: "old" })).toMatchObject({ code: "stale" })
  })

  it("refuses expired temporary credentials", () => {
    const r = evaluateActivation({
      ...base,
      authMode: "temporary",
      credentialExpiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    expect(r).toMatchObject({ allowed: false, code: "expired" })
  })

  it("always allows managed Vercel Blob (nothing to verify)", () => {
    expect(evaluateActivation({ ...base, provider: "vercel_blob", verificationStatus: "unverified" }).allowed).toBe(true)
  })
})

describe("clampTtlToCredentialExpiry (honest presigned-URL expiry)", () => {
  const now = new Date("2026-09-25T00:00:00Z")

  it("returns the requested ttl when credentials outlive it", () => {
    const exp = new Date(now.getTime() + 3600_000)
    expect(clampTtlToCredentialExpiry(300, exp, now)).toBe(300)
  })

  it("caps the ttl to the remaining credential lifetime", () => {
    const exp = new Date(now.getTime() + 100_000) // 100s left
    expect(clampTtlToCredentialExpiry(300, exp, now)).toBe(95) // minus 5s safety
  })

  it("returns 0 when credentials are already (nearly) expired", () => {
    const exp = new Date(now.getTime() + 1000)
    expect(clampTtlToCredentialExpiry(300, exp, now)).toBe(0)
  })

  it("passes the ttl through when there is no expiry", () => {
    expect(clampTtlToCredentialExpiry(300, null, now)).toBe(300)
  })
})
