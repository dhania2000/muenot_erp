import "server-only"
import { randomUUID } from "node:crypto"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  GetBucketLocationCommand,
  GetBucketEncryptionCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3"
import type {
  StorageProvider,
  UploadResult,
  DownloadResult,
  DownloadOptions,
  StorageObjectMeta,
  ResolvedConnection,
  HealthReport,
  MultipartHandle,
  MultipartPart,
  PresignUploadOptions,
  PresignedRequest,
} from "./types"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { HealthReportBuilder, describeError } from "./health"
import { getProviderDefinition, type ServerSideEncryptionMode } from "./providers"
import { clampTtl } from "./signing"
import {
  clampTtlToCredentialExpiry,
  expectedBucketOwnerFor,
  normalizeAuthMode,
  normalizeBucketRegion,
  parseRoleArn,
  sanitizeProviderMessage,
  tenantObjectPrefix,
  type AuthMode,
} from "./credentials"
import { credentialProviderFor, resolveCredentials, callerIdentity, StorageCredentialError } from "./iam"
import { MAX_UPLOAD_URL_TTL_SECONDS } from "./presign-policy"

/**
 * Classify a failure from the initial bucket probe so the report can attribute
 * it to the right stage. An HTTP status means we reached the service (so
 * connectivity is fine) and the problem is auth vs. bucket; no status means the
 * request never completed the round trip (network) unless the SDK rejected the
 * credentials before sending anything.
 */
function classifyBucketError(err: unknown): "network" | "credentials" | "bucket" {
  if (err instanceof StorageCredentialError) return "credentials"
  const e = err as any
  const name: string = e?.name || e?.Code || ""
  const status: number | undefined = e?.$metadata?.httpStatusCode
  const credNames = new Set([
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "CredentialsProviderError",
    "InvalidToken",
    "ExpiredToken",
    "AuthorizationHeaderMalformed",
  ])
  if (status) return credNames.has(name) || status === 401 ? "credentials" : "bucket"
  return credNames.has(name) ? "credentials" : "network"
}

function isAccessDenied(err: unknown): boolean {
  const e = err as any
  return e?.name === "AccessDenied" || e?.Code === "AccessDenied" || e?.$metadata?.httpStatusCode === 403
}

function isNotFound(err: unknown): boolean {
  const e = err as any
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

/** describeError with secrets scrubbed — every detail may end up in the audit log. */
function safeDetail(err: unknown): string {
  if (err instanceof StorageCredentialError) return err.message
  return sanitizeProviderMessage(describeError(err))
}

/**
 * A single S3 implementation that serves EVERY S3-compatible backend — AWS S3,
 * Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean Spaces, MinIO and any other
 * S3 gateway. Vendor differences come from the resolved connection + catalog.
 *
 * Credentials are resolved lazily per request through lib/storage/iam.ts
 * (static keys, temporary session credentials, or an assumed IAM role scoped to
 * this tenant's prefix) and never leave the server. On AWS, every server-side
 * call carries ExpectedBucketOwner so a bucket that changed hands (deleted and
 * re-created by someone else under the same name) is refused.
 */
export class S3StorageProvider implements StorageProvider {
  readonly id
  private readonly client: S3Client
  private readonly bucket: string
  private readonly publicBaseUrl: string | null
  /** bucket-level key prefix, applied transparently to every key. */
  private readonly prefix: string
  private readonly sse: ServerSideEncryptionMode
  private readonly conn: ResolvedConnection
  private readonly authMode: AuthMode
  private readonly isAws: boolean
  private readonly owner: string | null

  constructor(conn: ResolvedConnection) {
    this.id = conn.provider
    this.conn = conn
    this.bucket = conn.bucket
    this.publicBaseUrl = conn.publicBaseUrl?.replace(/\/+$/, "") || null
    this.prefix = (conn.pathPrefix ?? "").replace(/^\/+|\/+$/g, "")
    this.sse = conn.serverSideEncryption ?? "none"
    this.authMode = normalizeAuthMode(conn.authMode)
    this.isAws = conn.provider === "aws_s3"
    this.owner = this.isAws ? expectedBucketOwnerFor(conn) : null

    if (this.authMode === "iam_role" && !this.isAws) {
      throw new Error("IAM role credentials are only supported for Amazon S3")
    }
    if (this.authMode !== "iam_role" && (!conn.accessKeyId || !conn.secretAccessKey)) {
      throw new Error("Storage connection is missing access credentials")
    }

    const def = getProviderDefinition(conn.provider)
    const region = conn.region || def?.defaultRegion || "us-east-1"
    this.client = new S3Client({
      region,
      endpoint: conn.endpoint || undefined,
      forcePathStyle: conn.forcePathStyle ?? def?.forcePathStyle ?? false,
      credentials: credentialProviderFor(conn),
    })
  }

  /** Map a tenant-scoped key to the physical bucket key (with the prefix). */
  private full(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key
  }

  /** ExpectedBucketOwner for server-side calls (never on presigned URLs). */
  private ownerParam(): { ExpectedBucketOwner?: string } {
    return this.owner ? { ExpectedBucketOwner: this.owner } : {}
  }

  private sseParam(): { ServerSideEncryption?: ServerSideEncryptionMode } {
    return this.sse !== "none" ? { ServerSideEncryption: this.sse } : {}
  }

  /** The key prefix this tenant's credentials are scoped to. */
  private tenantPhysicalPrefix(): string {
    return tenantObjectPrefix(this.prefix, this.conn.tenantId)
  }

  async upload(
    key: string,
    data: Buffer,
    contentType: string,
    opts: { public?: boolean } = {},
  ): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        Body: data,
        ContentType: contentType || "application/octet-stream",
        ...this.sseParam(),
        ...this.ownerParam(),
      }),
    )
    const url = opts.public && this.publicBaseUrl ? `${this.publicBaseUrl}/${this.full(key)}` : proxyUrl(key)
    return { url, key, provider: this.id, size: data.length, contentType: contentType || null }
  }

  async download(key: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        ...(opts.range ? { Range: opts.range } : {}),
        ...this.ownerParam(),
      }),
    )
    const body = res.Body as unknown as ReadableStream<Uint8Array>
    if (!body) throw new Error("Object not found")
    const contentRange = res.ContentRange ?? null
    const total = contentRange
      ? Number(contentRange.split("/").pop()) || null
      : typeof res.ContentLength === "number"
        ? res.ContentLength
        : null
    return {
      body,
      contentType: res.ContentType ?? null,
      size: typeof res.ContentLength === "number" ? res.ContentLength : null,
      totalSize: total,
      etag: res.ETag ?? null,
      lastModified: res.LastModified?.toUTCString?.() ?? null,
      isPartial: Boolean(contentRange),
      contentRange,
    }
  }

  async stat(key: string): Promise<{ size: number; contentType: string | null; etag: string | null } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key), ...this.ownerParam() }),
      )
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null, etag: res.ETag ?? null }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async list(prefix: string, opts: { limit?: number } = {}): Promise<StorageObjectMeta[]> {
    const out: StorageObjectMeta[] = []
    const physicalPrefix = this.full(prefix)
    const stripLen = this.prefix ? this.prefix.length + 1 : 0
    let token: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: physicalPrefix,
          ContinuationToken: token,
          MaxKeys: opts.limit,
          ...this.ownerParam(),
        }),
      )
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue
        out.push({
          key: stripLen ? obj.Key.slice(stripLen) : obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.toISOString?.() ?? null,
        })
        if (opts.limit && out.length >= opts.limit) return out
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return out
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.full(key), ...this.ownerParam() }),
    )
  }

  /**
   * Resolve how long a presigned URL may live: the requested TTL, capped by the
   * lifetime of the credentials that sign it. Throws when they are expired.
   */
  private async effectiveTtl(requested: number): Promise<number> {
    const creds = await resolveCredentials(this.conn)
    const ttl = clampTtlToCredentialExpiry(requested, creds.expiration ?? null)
    if (ttl <= 0) throw new StorageCredentialError("expired", "The storage credentials are about to expire")
    return ttl
  }

  /** Native S3 presigned GET URL (caller has already authorized the key). */
  async presign(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const expiresIn = await this.effectiveTtl(clampTtl(opts.expiresIn))
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }), {
      expiresIn,
    })
  }

  /**
   * Presigned single-request PUT. Content-Type and Content-Length are part of
   * the signature, so the browser cannot upload a larger or different-typed
   * object than the server authorized. SSE is left as a signed header the
   * client must echo, so the bucket enforces encryption on the object.
   */
  async presignUpload(key: string, opts: PresignUploadOptions): Promise<PresignedRequest> {
    const requested = Math.min(opts.expiresIn ?? 300, MAX_UPLOAD_URL_TTL_SECONDS)
    const expiresIn = await this.effectiveTtl(requested)
    const contentType = opts.contentType || "application/octet-stream"
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        ContentType: contentType,
        ContentLength: opts.contentLength,
        ...this.sseParam(),
      }),
      {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
        unhoistableHeaders: new Set(["x-amz-server-side-encryption"]),
      },
    )
    const headers: Record<string, string> = { "Content-Type": contentType }
    if (this.sse !== "none") headers["x-amz-server-side-encryption"] = this.sse
    return { url, method: "PUT", headers, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
  }

  /** Presigned URL for one multipart chunk (direct browser → bucket). */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 300,
  ): Promise<PresignedRequest> {
    const ttl = await this.effectiveTtl(Math.min(expiresIn, MAX_UPLOAD_URL_TTL_SECONDS))
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: this.full(key), UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: ttl },
    )
    return { url, method: "PUT", headers: {}, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }
  }

  async listUploadedParts(key: string, uploadId: string): Promise<MultipartPart[]> {
    const out: MultipartPart[] = []
    let marker: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: this.full(key),
          UploadId: uploadId,
          PartNumberMarker: marker,
          ...this.ownerParam(),
        }),
      )
      for (const p of res.Parts ?? []) {
        if (p.PartNumber && p.ETag) out.push({ partNumber: p.PartNumber, etag: p.ETag })
      }
      if (!res.IsTruncated || !res.NextPartNumberMarker) break
      marker = String(res.NextPartNumberMarker)
    }
    return out
  }

  async createMultipart(
    key: string,
    contentType: string,
    _opts: { public?: boolean } = {},
  ): Promise<MultipartHandle> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        ContentType: contentType || "application/octet-stream",
        ...this.sseParam(),
        ...this.ownerParam(),
      }),
    )
    if (!created.UploadId) throw new Error("Provider did not return a multipart upload ID")
    return { uploadId: created.UploadId }
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Buffer): Promise<MultipartPart> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: data,
        ...this.ownerParam(),
      }),
    )
    if (!res.ETag) throw new Error("Provider did not return a part ETag")
    return { partNumber, etag: res.ETag }
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<UploadResult> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
        ...this.ownerParam(),
      }),
    )
    return { url: proxyUrl(key), key, provider: this.id, size: 0, contentType: null }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.full(key),
          UploadId: uploadId,
          ...this.ownerParam(),
        }),
      )
      .catch(() => {})
  }

  /**
   * Bucket reachability probe. A role session is scoped to the tenant prefix,
   * so it cannot HeadBucket (which needs unconditioned s3:ListBucket); it lists
   * its own prefix instead.
   */
  private async probeBucket(): Promise<void> {
    if (this.authMode === "iam_role") {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.tenantPhysicalPrefix(),
          MaxKeys: 1,
          ...this.ownerParam(),
        }),
      )
      return
    }
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket, ...this.ownerParam() }))
  }

  async healthCheck(): Promise<void> {
    await this.probeBucket()
  }

  /**
   * Capability diagnostics. Probes write/read/delete/multipart under the
   * TENANT's prefix (the only place a scoped role may write), always cleaning up.
   */
  async diagnose(): Promise<HealthReport> {
    const b = new HealthReportBuilder()
    await this.runCapabilityChecks(b)
    return b.build()
  }

  private async runCapabilityChecks(b: HealthReportBuilder): Promise<boolean> {
    let bucketOk = false
    const start = Date.now()
    try {
      await this.probeBucket()
      b.pass("connectivity", "Reached the storage endpoint", Date.now() - start)
      b.pass("credentials", "Credentials accepted")
      b.pass("bucket", `Bucket "${this.bucket}" is reachable`)
      bucketOk = true
    } catch (err) {
      const duration = Date.now() - start
      const kind = classifyBucketError(err)
      const detail = safeDetail(err)
      if (kind === "network") {
        b.fail("connectivity", detail, duration)
        b.skip("credentials", "Skipped — could not reach the endpoint")
        b.skip("bucket", "Skipped — could not reach the endpoint")
      } else if (kind === "credentials") {
        b.pass("connectivity", "Reached the storage endpoint", duration)
        b.fail("credentials", detail)
        b.skip("bucket", "Skipped — credentials were rejected")
      } else {
        b.pass("connectivity", "Reached the storage endpoint", duration)
        b.pass("credentials", "Credentials accepted")
        b.fail("bucket", detail)
      }
    }

    if (!bucketOk) {
      for (const id of ["write", "read", "delete", "multipart"] as const) {
        b.skip(id, "Skipped — bucket is not accessible")
      }
      return false
    }

    const key = `${this.tenantPhysicalPrefix()}.v0-healthcheck/${randomUUID()}.txt`
    const payload = Buffer.from(`v0 storage health check ${new Date().toISOString()}`)
    const wrote = await b.run("write", async () => {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: payload,
          ContentType: "text/plain",
          ...this.sseParam(),
          ...this.ownerParam(),
        }),
      )
      return "Wrote a temporary test object"
    })

    if (wrote) {
      await b.run("read", async () => {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...this.ownerParam() }))
        const body = res.Body as any
        const bytes: Uint8Array | null = body?.transformToByteArray ? await body.transformToByteArray() : null
        if (bytes && bytes.byteLength !== payload.byteLength) {
          throw new Error("Object read back did not match what was written")
        }
        return "Read the test object back"
      })
      await b.run("delete", async () => {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, ...this.ownerParam() }))
        return "Deleted the test object"
      })
    } else {
      b.skip("read", "Skipped — write failed")
      b.skip("delete", "Skipped — nothing was written to clean up")
    }

    await b.run("multipart", async () => {
      const mpKey = `${this.tenantPhysicalPrefix()}.v0-healthcheck/${randomUUID()}.part`
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: mpKey,
          ContentType: "application/octet-stream",
          ...this.sseParam(),
          ...this.ownerParam(),
        }),
      )
      const uploadId = created.UploadId
      if (!uploadId) throw new Error("Provider did not return a multipart upload ID")
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: mpKey, UploadId: uploadId, ...this.ownerParam() }),
      )
      return "Initiated and aborted a multipart upload"
    })
    return true
  }

  /**
   * Pre-activation verification: identity, ownership, region, encryption and
   * permission scope, followed by the capability probes. A connection may only
   * be activated after this reports `ok` for its current configuration.
   */
  async verify(): Promise<HealthReport & { observed: { account: string | null; bucketRegion: string | null } }> {
    const b = new HealthReportBuilder()
    const observed = { account: null as string | null, bucketRegion: null as string | null }

    // 1. Identity — who do these credentials act as?
    let identityOk = true
    let callerAccount: string | null = null
    if (this.isAws) {
      const start = Date.now()
      try {
        const id = await callerIdentity(this.conn)
        callerAccount = id.account
        observed.account = id.account
        const roleAccount = parseRoleArn(this.conn.roleArn)?.accountId ?? null
        if (this.authMode === "iam_role" && roleAccount && id.account !== roleAccount) {
          identityOk = false
          b.fail("identity", "Assumed identity does not belong to the role's account", Date.now() - start)
        } else {
          b.pass(
            "identity",
            this.authMode === "iam_role"
              ? `Assumed role in account ${id.account}`
              : `Credentials belong to account ${id.account}`,
            Date.now() - start,
          )
        }
      } catch (err) {
        identityOk = false
        b.fail("identity", safeDetail(err), Date.now() - start)
      }
    } else {
      b.skip("identity", "Not applicable for this S3-compatible provider")
    }

    if (!identityOk) {
      for (const id of ["ownership", "region", "encryption", "scope"] as const) b.skip(id, "Skipped — identity check failed")
      for (const id of ["connectivity", "credentials", "bucket", "write", "read", "delete", "multipart"] as const) {
        b.skip(id, "Skipped — identity check failed")
      }
      return { ...b.build(), observed }
    }

    // 2. Region — the bucket must live where the connection says.
    if (this.isAws) {
      await b.run("region", async () => {
        const res = await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket }))
        const actual = normalizeBucketRegion(res.LocationConstraint as string | undefined)
        observed.bucketRegion = actual
        const configured = this.conn.region || "us-east-1"
        if (actual !== configured) {
          throw new Error(`Bucket is in ${actual} but the connection is configured for ${configured}`)
        }
        return `Bucket region ${actual} matches`
      })
    } else {
      b.skip("region", "Not applicable for this S3-compatible provider")
    }

    // 3. Ownership — ExpectedBucketOwner makes S3 refuse a bucket owned by anyone else.
    if (this.isAws) {
      const expected = this.owner ?? callerAccount
      await b.run("ownership", async () => {
        if (!expected) throw new Error("Could not determine the expected bucket owner account")
        try {
          await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket, ExpectedBucketOwner: expected }))
        } catch (err) {
          if (isAccessDenied(err)) throw new Error(`Bucket is not owned by account ${expected}`)
          throw err
        }
        return `Bucket is owned by account ${expected}`
      })
    } else {
      b.skip("ownership", "Bucket ownership cannot be asserted for this provider; access is verified below")
    }

    // 4. Encryption — objects must be encrypted at rest.
    if (this.isAws) {
      await b.run("encryption", async () => {
        try {
          const res = await this.client.send(
            new GetBucketEncryptionCommand({ Bucket: this.bucket, ...(this.owner ? { ExpectedBucketOwner: this.owner } : {}) }),
          )
          const algo =
            res.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null
          if (!algo && this.sse === "none") throw new Error("Bucket has no default encryption and none is requested")
          return `Bucket default ${algo ?? "none"}${this.sse !== "none" ? `; objects written with ${this.sse}` : ""}`
        } catch (err) {
          if (this.sse !== "none" && isAccessDenied(err)) {
            return `Cannot read bucket default; every object is written with ${this.sse}`
          }
          throw err
        }
      })
    } else if (this.sse !== "none") {
      b.pass("encryption", `Objects are written with ${this.sse}`)
    } else {
      b.skip("encryption", "No server-side encryption requested")
    }

    // 5. Capabilities under the tenant prefix.
    const capable = await this.runCapabilityChecks(b)

    // 6. Scope — a role session must NOT be able to write outside this tenant.
    if (this.authMode === "iam_role" && capable) {
      const probeKey = this.full(`t/0/.v0-scope-probe/${randomUUID()}`)
      const start = Date.now()
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: probeKey, Body: "x", ...this.sseParam(), ...this.ownerParam() }),
        )
        await this.client
          .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: probeKey, ...this.ownerParam() }))
          .catch(() => {})
        b.fail("scope", "Credentials could write outside this workspace's prefix", Date.now() - start)
      } catch (err) {
        if (isAccessDenied(err)) b.pass("scope", "Writes outside this workspace's prefix are denied", Date.now() - start)
        else b.fail("scope", safeDetail(err), Date.now() - start)
      }
    } else if (this.authMode === "iam_role") {
      b.skip("scope", "Skipped — bucket is not accessible")
    } else {
      b.skip(
        "scope",
        "Static credentials are not narrowed per workspace; keys are still namespaced and checked server-side",
      )
    }

    return { ...b.build(), observed }
  }
}

/** The app-internal, tenant-scoped download path for a private object key. */
export function proxyUrl(key: string): string {
  return `/api/storage/file/${key.split("/").map(encodeURIComponent).join("/")}`
}
