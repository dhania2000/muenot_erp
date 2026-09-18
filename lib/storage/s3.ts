import "server-only"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from "@aws-sdk/client-s3"
import type { StorageProvider, UploadResult, DownloadResult, StorageObjectMeta, ResolvedConnection } from "./types"
import { getProviderDefinition, type ServerSideEncryptionMode } from "./providers"

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

  async healthCheck(): Promise<void> {
    // HeadBucket verifies both connectivity and that the credentials can reach
    // the target bucket, without needing any object to exist.
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }
}

/** The app-internal, tenant-scoped download path for a private object key. */
export function proxyUrl(key: string): string {
  return `/api/storage/file/${key.split("/").map(encodeURIComponent).join("/")}`
}
