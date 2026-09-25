import { afterEach, describe, expect, it, vi } from "vitest"
import type { ResolvedConnection } from "@/lib/storage/types"
import {
  __resetCredentialCacheForTests,
  connectionFingerprint,
  invalidateCredentialCache,
  resolveCredentials,
  StorageCredentialError,
} from "@/lib/storage/iam"

/**
 * Spec7 — server-side credential resolution.
 *
 * Exercises the three auth modes plus the failure paths the spec calls out:
 * revoked connection, expired temporary credentials and an "incorrect role"
 * (AssumeRole denied by the trust policy). A fake STS client is injected so no
 * network or real AWS credentials are needed.
 */

function conn(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 1,
    tenantId: 42,
    provider: "aws_s3",
    name: "primary",
    bucket: "cust-bucket",
    region: "us-east-1",
    endpoint: null,
    accessKeyId: null,
    secretAccessKey: null,
    forcePathStyle: false,
    publicBaseUrl: null,
    pathPrefix: "erp",
    serverSideEncryption: "AES256",
    isActive: true,
    authMode: "access_key",
    sessionToken: null,
    credentialExpiresAt: null,
    roleArn: null,
    externalId: null,
    expectedBucketOwner: null,
    verificationStatus: "verified",
    verifiedFingerprint: null,
    verifiedAt: null,
    verificationDetail: null,
    revokedAt: null,
    revokedBy: null,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as ResolvedConnection
}

/** Build a fake STS whose AssumeRole either returns creds or throws. */
function fakeSts(behavior: { creds?: any; throws?: any }) {
  const send = vi.fn(async (_command?: { input: { Policy: string; ExternalId: string } }) => {
    if (behavior.throws) throw behavior.throws
    return { Credentials: behavior.creds }
  })
  const factory = vi.fn((_region: string) => ({ send }) as any)
  return { factory, send }
}

afterEach(() => {
  __resetCredentialCacheForTests()
  vi.restoreAllMocks()
})

describe("access_key mode", () => {
  it("returns the stored key pair", async () => {
    const creds = await resolveCredentials(conn({ accessKeyId: "AKIA", secretAccessKey: "secret" }))
    expect(creds).toEqual({ accessKeyId: "AKIA", secretAccessKey: "secret" })
  })

  it("throws missing when key material is absent", async () => {
    await expect(resolveCredentials(conn())).rejects.toMatchObject({ code: "missing" })
  })
})

describe("temporary mode", () => {
  it("returns key + secret + session token before expiry", async () => {
    const creds = await resolveCredentials(
      conn({
        authMode: "temporary",
        accessKeyId: "ASIA",
        secretAccessKey: "secret",
        sessionToken: "tok",
        credentialExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )
    expect(creds.sessionToken).toBe("tok")
  })

  it("throws missing without a session token", async () => {
    await expect(
      resolveCredentials(conn({ authMode: "temporary", accessKeyId: "ASIA", secretAccessKey: "s" })),
    ).rejects.toMatchObject({ code: "missing" })
  })

  it("throws expired once the credentials lapse", async () => {
    await expect(
      resolveCredentials(
        conn({
          authMode: "temporary",
          accessKeyId: "ASIA",
          secretAccessKey: "s",
          sessionToken: "tok",
          credentialExpiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "expired" })
  })
})

describe("iam_role mode", () => {
  const roleConn = () =>
    conn({
      authMode: "iam_role",
      roleArn: "arn:aws:iam::123456789012:role/muenot-storage",
      externalId: "muenot-secret",
    })

  it("assumes the role, scoping the session, and caches the result", async () => {
    const expiration = new Date(Date.now() + 900_000)
    const { factory, send } = fakeSts({
      creds: { AccessKeyId: "ASIA1", SecretAccessKey: "s1", SessionToken: "t1", Expiration: expiration },
    })
    const c1 = await resolveCredentials(roleConn(), { stsFactory: factory })
    expect(c1).toMatchObject({ accessKeyId: "ASIA1", sessionToken: "t1" })

    // The inline session policy pins the tenant prefix.
    const sentPolicy = JSON.parse(String(send.mock.calls[0]?.[0]?.input.Policy))
    expect(JSON.stringify(sentPolicy)).toContain("cust-bucket/erp/t/42/*")
    expect(send.mock.calls[0]?.[0]?.input.ExternalId).toBe("muenot-secret")

    // A second call within the cache window does not hit STS again.
    await resolveCredentials(roleConn(), { stsFactory: factory })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("re-assumes after the cache is invalidated (e.g. on revoke/edit)", async () => {
    const { factory, send } = fakeSts({
      creds: {
        AccessKeyId: "ASIA1",
        SecretAccessKey: "s1",
        SessionToken: "t1",
        Expiration: new Date(Date.now() + 900_000),
      },
    })
    await resolveCredentials(roleConn(), { stsFactory: factory })
    invalidateCredentialCache(42, 1)
    await resolveCredentials(roleConn(), { stsFactory: factory })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("classifies an incorrect/denied role as trust_denied", async () => {
    const { factory } = fakeSts({ throws: { name: "AccessDenied", $metadata: { httpStatusCode: 403 } } })
    await expect(resolveCredentials(roleConn(), { stsFactory: factory })).rejects.toMatchObject({
      code: "trust_denied",
    })
  })

  it("rejects an invalid role ARN before calling STS", async () => {
    const { factory, send } = fakeSts({ creds: {} })
    await expect(
      resolveCredentials(conn({ authMode: "iam_role", roleArn: "not-an-arn", externalId: "x" }), {
        stsFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "role_invalid" })
    expect(send).not.toHaveBeenCalled()
  })

  it("throws missing when the external id is absent", async () => {
    const { factory } = fakeSts({ creds: {} })
    await expect(
      resolveCredentials(
        conn({ authMode: "iam_role", roleArn: "arn:aws:iam::123456789012:role/x", externalId: null }),
        { stsFactory: factory },
      ),
    ).rejects.toMatchObject({ code: "missing" })
  })
})

describe("revoked connection", () => {
  it("refuses to resolve any credentials", async () => {
    await expect(
      resolveCredentials(conn({ accessKeyId: "AKIA", secretAccessKey: "s", revokedAt: new Date().toISOString() })),
    ).rejects.toMatchObject({ code: "revoked" })
  })

  it("throws a StorageCredentialError instance", async () => {
    const err = await resolveCredentials(conn({ revokedAt: new Date().toISOString() })).catch((e) => e)
    expect(err).toBeInstanceOf(StorageCredentialError)
  })
})

describe("connectionFingerprint", () => {
  it("changes when credential-affecting config changes and never leaks secrets", () => {
    const a = connectionFingerprint(conn({ accessKeyId: "AKIA", secretAccessKey: "s" }))
    const b = connectionFingerprint(conn({ accessKeyId: "AKIA", secretAccessKey: "different" }))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain("AKIA")
  })

  it("is stable for identical config", () => {
    expect(connectionFingerprint(conn({ accessKeyId: "AKIA", secretAccessKey: "s" }))).toBe(
      connectionFingerprint(conn({ accessKeyId: "AKIA", secretAccessKey: "s" })),
    )
  })
})
