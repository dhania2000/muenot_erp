import "server-only"
import { randomUUID } from "node:crypto"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3"
import type {
  StorageProvider,
  UploadResult,
  DownloadResult,
  StorageObjectMeta,
  ResolvedConnection,
  HealthReport,
  MultipartHandle,
  MultipartPart,
} from "./types"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { HealthReportBuilder, describeError } from "./health"
import { getProviderDefinition, type ServerSideEncryptionMode } from "./providers"
import { clampTtl } from "./signing"

/**
 * SPEC 28 — Classify a failure from the initial HeadBucket probe so the report
 * can attribute it to the right stage. An HTTP status means we reached the
 * service (so connectivity is fine) and the problem is auth vs. bucket; no
 * status means the request never completed the round trip (network) unless the
 * SDK rejected the credentials before sending anything.
 */
function classifyBucketError(err: unknown): "network" | "credentials" | "bucket" {
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
  // No HTTP status: either creds rejected locally, or a transport failure.
  return credNames.has(name) ? "credentials" : "network"
}

/**
 * A single S3 implementation that serves EVERY S3-compatible backend — AWS S3,
 * Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean Spaces, MinIO and any other
 * S3 gateway. The vendor differences (endpoint, region, path-style addressing)
 * come entirely from the resolved connection + provider catalog, so there is no
 * per-vendor code to maintain.
 *
 * The customer's credentials are read from their stored connection and used ONLY
 * on the server; they are never sent to the client. Uploads are private by
 * default and served back through the app's tenant-scoped download proxy, so a
 * bucket does not need to be public and objects can never be listed across
 * tenants.
 */
export class S3StorageProvider implements StorageProvider {
  readonly id
  private readonly client: S3Client
  private readonly bucket: string
  private readonly publicBaseUrl: string | null
  /** SPEC 27 — bucket-level key prefix, applied transparently to every key. */
  private readonly prefix: string
  /** SPEC 27 — server-side encryption applied to uploaded objects. */
  private readonly sse: ServerSideEncryptionMode

  constructor(conn: ResolvedConnection) {
    this.id = conn.provider
    this.bucket = conn.bucket
    this.publicBaseUrl = conn.publicBaseUrl?.replace(/\/+$/, "") || null
    this.prefix = (conn.pathPrefix ?? "").replace(/^\/+|\/+$/g, "")
    this.sse = conn.serverSideEncryption ?? "none"

    const def = getProviderDefinition(conn.provider)
    const region = conn.region || def?.defaultRegion || "us-east-1"
    if (!conn.accessKeyId || !conn.secretAccessKey) {
      throw new Error("Storage connection is missing access credentials")
    }
    this.client = new S3Client({
      region,
      endpoint: conn.endpoint || undefined,
      forcePathStyle: conn.forcePathStyle ?? def?.forcePathStyle ?? false,
      credentials: {
        accessKeyId: conn.accessKeyId,
        secretAccessKey: conn.secretAccessKey,
      },
    })
  }

  /** Map a tenant-scoped key to the physical bucket key (with the prefix). */
  private full(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key
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
        ...(this.sse !== "none" ? { ServerSideEncryption: this.sse } : {}),
      }),
    )
    // For public buckets with a configured CDN base, hand back a direct link;
    // otherwise the caller stores the (tenant) key and serves via the proxy.
    const url = opts.public && this.publicBaseUrl ? `${this.publicBaseUrl}/${this.full(key)}` : proxyUrl(key)
    return { url, key, provider: this.id, size: data.length, contentType: contentType || null }
  }

  async download(key: string): Promise<DownloadResult> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }))
    const body = res.Body as unknown as ReadableStream<Uint8Array>
    if (!body) throw new Error("Object not found")
    return {
      body,
      contentType: res.ContentType ?? null,
      size: typeof res.ContentLength === "number" ? res.ContentLength : null,
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
        }),
      )
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue
        // Strip the connection prefix so callers keep seeing tenant-scoped keys.
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
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.full(key) }))
  }

  /**
   * SPEC 29 — Native S3 presigned GET URL. The URL is time-limited and scoped
   * to the single object; the bucket stays private (no public ACL needed).
   * The caller is responsible for having validated session + tenant ownership
   * of `key` before requesting this.
   */
  async presign(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const expiresIn = clampTtl(opts.expiresIn)
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }), {
      expiresIn,
    })
  }

  /**
   * SPEC 30 — Native S3 multipart upload. The upload ID returned by the service
   * is stable across requests, so each chunk arrives as its own stateless HTTP
   * request and is streamed straight to the bucket without buffering the whole
   * file server-side.
   */
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
        ...(this.sse !== "none" ? { ServerSideEncryption: this.sse } : {}),
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
      }),
    )
    return { url: proxyUrl(key), key, provider: this.id, size: 0, contentType: null }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client
      .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.full(key), UploadId: uploadId }))
      .catch(() => {})
  }

  async healthCheck(): Promise<void> {
    // HeadBucket verifies both connectivity and that the credentials can reach
    // the target bucket, without needing any object to exist.
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }

  /**
   * SPEC 28 — Full diagnostic run. Probes every storage capability in order and
   * reports each as pass/fail/skip. Later probes are skipped (never run) once a
   * prerequisite fails, so an admin sees exactly where the chain breaks without
   * a cascade of misleading errors. A temporary object is written under a
   * `.v0-healthcheck/` prefix and always cleaned up.
   */
  async diagnose(): Promise<HealthReport> {
    const b = new HealthReportBuilder()

    // 1-3. One HeadBucket call covers connectivity, credentials and bucket
    // access; we attribute a failure to the correct stage and skip the rest.
    let bucketOk = false
    const start = Date.now()
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
      b.pass("connectivity", "Reached the storage endpoint", Date.now() - start)
      b.pass("credentials", "Credentials accepted")
      b.pass("bucket", `Bucket "${this.bucket}" is reachable`)
      bucketOk = true
    } catch (err) {
      const duration = Date.now() - start
      const kind = classifyBucketError(err)
      const detail = describeError(err)
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
      b.skip("write", "Skipped — bucket is not accessible")
      b.skip("read", "Skipped — bucket is not accessible")
      b.skip("delete", "Skipped — bucket is not accessible")
      b.skip("multipart", "Skipped — bucket is not accessible")
      return b.build()
    }

    // 4-6. Write → read → delete a single throwaway object.
    const key = this.full(`.v0-healthcheck/${randomUUID()}.txt`)
    const payload = Buffer.from(`v0 storage health check ${new Date().toISOString()}`)
    const wrote = await b.run("write", async () => {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: payload,
          ContentType: "text/plain",
          ...(this.sse !== "none" ? { ServerSideEncryption: this.sse } : {}),
        }),
      )
      return "Wrote a temporary test object"
    })

    if (wrote) {
      await b.run("read", async () => {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
        const body = res.Body as any
        const bytes: Uint8Array | null = body?.transformToByteArray ? await body.transformToByteArray() : null
        if (bytes && bytes.byteLength !== payload.byteLength) {
          throw new Error("Object read back did not match what was written")
        }
        return "Read the test object back"
      })
      await b.run("delete", async () => {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
        return "Deleted the test object"
      })
    } else {
      b.skip("read", "Skipped — write failed")
      b.skip("delete", "Skipped — nothing was written to clean up")
    }

    // 7. Multipart support: initiate then immediately abort (no parts uploaded),
    // which exercises the multipart API path without leaving an open upload.
    await b.run("multipart", async () => {
      const mpKey = this.full(`.v0-healthcheck/${randomUUID()}.part`)
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: mpKey,
          ContentType: "application/octet-stream",
          ...(this.sse !== "none" ? { ServerSideEncryption: this.sse } : {}),
        }),
      )
      const uploadId = created.UploadId
      if (!uploadId) throw new Error("Provider did not return a multipart upload ID")
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: mpKey, UploadId: uploadId }),
      )
      return "Initiated and aborted a multipart upload"
    })

    return b.build()
  }
}

/** The app-internal, tenant-scoped download path for a private object key. */
export function proxyUrl(key: string): string {
  return `/api/storage/file/${key.split("/").map(encodeURIComponent).join("/")}`
}
