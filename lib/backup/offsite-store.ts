import "server-only"
/**
 * Off-site backup object sink (server driver).
 * ---------------------------------------------------------------------------
 * Writes the encrypted backup artifact to storage that is INDEPENDENT of the
 * primary MySQL database, so a database loss can never take the backups with
 * it. Two drivers share one interface:
 *
 *   - s3    : any S3-compatible bucket, with S3 Object Lock (WORM) retention for
 *             immutability and a cross-region copy to a replica bucket.
 *   - local : a filesystem directory (dev / self-hosted without S3) that still
 *             lives outside the database, with a retain-until sidecar enforcing
 *             the same immutable window and an optional replica directory.
 *
 * When neither is configured the sink is DISABLED and the backup engine falls
 * back to the legacy inline MySQL blob — reported honestly in the UI rather
 * than pretending an off-site copy exists.
 *
 * All transfer decisions (single PUT vs. multipart, retry-on-interruption,
 * backoff, delete-eligibility) come from the pure lib/backup/offsite-model.ts
 * so they are unit-tested without a network.
 */
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises"
import { dirname, join, normalize, sep } from "node:path"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3"
import {
  type OffsiteConfig,
  type OffsiteEndpoint,
  type OffsiteStatus,
  buildObjectKey,
  classifyUploadError,
  describeOffsite,
  isDeleteAllowed,
  nextRetryDelayMs,
  partRange,
  planUpload,
  readOffsiteConfig,
  shouldRetryUpload,
} from "@/lib/backup/offsite-model"

const MAX_ATTEMPTS = 4

// ---------------------------------------------------------------------------
// Cached config
// ---------------------------------------------------------------------------

let cachedConfig: OffsiteConfig | null = null

export function offsiteConfig(): OffsiteConfig {
  if (!cachedConfig) cachedConfig = readOffsiteConfig()
  return cachedConfig
}

/** Test-only hook to force a fresh read after mutating the environment. */
export function resetOffsiteConfigCache(): void {
  cachedConfig = null
}

export function offsiteStatus(): OffsiteStatus {
  return describeOffsite(offsiteConfig())
}

export function offsiteEnabled(): boolean {
  return offsiteConfig().mode !== "disabled"
}

// ---------------------------------------------------------------------------
// Stored-object reference (persisted alongside the run row)
// ---------------------------------------------------------------------------

export type StoredObjectRef = {
  location: "offsite"
  mode: "s3" | "local"
  key: string
  bucket: string
  region: string
  replicaKey: string | null
  replicaRegion: string | null
  retainUntil: Date | null
  immutable: boolean
}

export type PutInput = {
  tenantId: number | null
  scope: string
  runId: number
  generatedAt: Date
  bytes: Buffer
  retainUntil: Date | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

function s3ClientFor(endpoint: OffsiteEndpoint): S3Client {
  const accessKeyId = process.env.BACKUP_OFFSITE_ACCESS_KEY_ID
  const secretAccessKey = process.env.BACKUP_OFFSITE_SECRET_ACCESS_KEY
  return new S3Client({
    region: endpoint.region,
    endpoint: endpoint.endpoint || undefined,
    forcePathStyle: Boolean(endpoint.endpoint),
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, sessionToken: process.env.BACKUP_OFFSITE_SESSION_TOKEN || undefined }
        : undefined, // fall back to the ambient AWS credential chain
  })
}

/** Retry a single-shot storage op while the failure looks transient. */
async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    try {
      return await op()
    } catch (err) {
      const cls = classifyUploadError(err)
      if (!shouldRetryUpload(cls, attempt, MAX_ATTEMPTS)) throw err
      await sleep(nextRetryDelayMs(attempt))
    }
  }
}

async function s3PutSingle(client: S3Client, endpoint: OffsiteEndpoint, key: string, bytes: Buffer, retainUntil: Date | null, config: OffsiteConfig): Promise<void> {
  await withRetry(() =>
    client.send(
      new PutObjectCommand({
        Bucket: endpoint.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
        ...(config.immutable && retainUntil
          ? { ObjectLockMode: config.lockMode, ObjectLockRetainUntilDate: retainUntil }
          : {}),
      }),
    ),
  )
}

/**
 * Large artifacts are uploaded in >=5MB parts. Each part is retried
 * independently, so an interrupted transfer resumes the failed part instead of
 * restarting from zero. A hard failure aborts the multipart upload to avoid
 * leaving orphaned parts (and storage charges) behind.
 */
async function s3PutMultipart(client: S3Client, endpoint: OffsiteEndpoint, key: string, bytes: Buffer, retainUntil: Date | null, config: OffsiteConfig): Promise<void> {
  const plan = planUpload(bytes.length)
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: endpoint.bucket,
      Key: key,
      ContentType: "application/octet-stream",
      ...(config.immutable && retainUntil
        ? { ObjectLockMode: config.lockMode, ObjectLockRetainUntilDate: retainUntil }
        : {}),
    }),
  )
  const uploadId = created.UploadId
  try {
    const parts: { ETag: string; PartNumber: number }[] = []
    for (let partNumber = 1; partNumber <= plan.partCount; partNumber++) {
      const { start, end } = partRange(plan, partNumber)
      const chunk = bytes.subarray(start, end)
      const res = await withRetry(() =>
        client.send(
          new UploadPartCommand({ Bucket: endpoint.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: chunk }),
        ),
      )
      parts.push({ ETag: String(res.ETag), PartNumber: partNumber })
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: endpoint.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    )
  } catch (err) {
    await client.send(new AbortMultipartUploadCommand({ Bucket: endpoint.bucket, Key: key, UploadId: uploadId })).catch(() => {})
    throw err
  }
}

async function s3Put(endpoint: OffsiteEndpoint, key: string, bytes: Buffer, retainUntil: Date | null, config: OffsiteConfig): Promise<void> {
  const client = s3ClientFor(endpoint)
  try {
    if (planUpload(bytes.length).multipart) await s3PutMultipart(client, endpoint, key, bytes, retainUntil, config)
    else await s3PutSingle(client, endpoint, key, bytes, retainUntil, config)
  } finally {
    client.destroy()
  }
}

async function s3Get(endpoint: OffsiteEndpoint, key: string): Promise<Buffer> {
  const client = s3ClientFor(endpoint)
  try {
    const res = await withRetry(() => client.send(new GetObjectCommand({ Bucket: endpoint.bucket, Key: key })))
    const body = res.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> }
    if (!body?.transformToByteArray) throw new Error("Empty object body")
    return Buffer.from(await body.transformToByteArray())
  } finally {
    client.destroy()
  }
}

async function s3Delete(endpoint: OffsiteEndpoint, key: string): Promise<void> {
  const client = s3ClientFor(endpoint)
  try {
    await client.send(new DeleteObjectCommand({ Bucket: endpoint.bucket, Key: key }))
  } finally {
    client.destroy()
  }
}

// ---------------------------------------------------------------------------
// Local filesystem driver
// ---------------------------------------------------------------------------

/** Resolve a key to an absolute path, refusing traversal outside the root. */
function localPath(root: string, key: string): string {
  const full = normalize(join(root, key))
  const base = normalize(root)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("Refusing to write outside the off-site root")
  }
  return full
}

type LocalMeta = { retainUntil: string | null; immutable: boolean }

async function localPut(root: string, key: string, bytes: Buffer, retainUntil: Date | null, immutable: boolean): Promise<void> {
  const path = localPath(root, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  const meta: LocalMeta = { retainUntil: retainUntil ? retainUntil.toISOString() : null, immutable }
  await writeFile(`${path}.meta.json`, JSON.stringify(meta), "utf-8")
}

async function localGet(root: string, key: string): Promise<Buffer> {
  return readFile(localPath(root, key))
}

async function localDelete(root: string, key: string, now: Date): Promise<boolean> {
  const path = localPath(root, key)
  let meta: LocalMeta = { retainUntil: null, immutable: false }
  try {
    meta = JSON.parse(await readFile(`${path}.meta.json`, "utf-8")) as LocalMeta
  } catch {
    /* no sidecar — treat as mutable */
  }
  if (!isDeleteAllowed(meta.retainUntil, meta.immutable, now)) return false
  await unlink(path).catch(() => {})
  await unlink(`${path}.meta.json`).catch(() => {})
  return true
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist encrypted bytes off-site (primary + cross-region replica) and return
 * a reference to store on the run row. Throws only when the PRIMARY write
 * fails; a replica failure degrades to a null replica reference so a single
 * region outage never blocks the backup.
 */
export async function putArtifactOffsite(input: PutInput): Promise<StoredObjectRef | null> {
  const config = offsiteConfig()
  if (config.mode === "disabled" || !config.primary) return null
  const key = buildObjectKey({
    prefix: config.primary.prefix,
    tenantId: input.tenantId,
    scope: input.scope,
    runId: input.runId,
    generatedAt: input.generatedAt,
  })

  if (config.mode === "s3") {
    await s3Put(config.primary, key, input.bytes, input.retainUntil, config)
  } else {
    await localPut(config.localDir!, key, input.bytes, input.retainUntil, config.immutable)
  }

  let replicaKey: string | null = null
  let replicaRegion: string | null = null
  if (config.replica) {
    try {
      if (config.mode === "s3") await s3Put(config.replica, key, input.bytes, input.retainUntil, config)
      else await localPut(config.replica.bucket, key, input.bytes, input.retainUntil, config.immutable)
      replicaKey = key
      replicaRegion = config.replica.region
    } catch (err) {
      console.error("[backup] cross-region replica write failed", err)
    }
  }

  return {
    location: "offsite",
    mode: config.mode,
    key,
    bucket: config.primary.bucket,
    region: config.primary.region,
    replicaKey,
    replicaRegion,
    retainUntil: input.retainUntil,
    immutable: config.immutable,
  }
}

/** Read encrypted bytes back, preferring the primary and falling back to the replica. */
export async function getArtifactOffsite(ref: Pick<StoredObjectRef, "mode" | "key" | "replicaKey">): Promise<Buffer> {
  const config = offsiteConfig()
  if (!config.primary) throw new Error("Off-site storage is not configured")
  try {
    if (ref.mode === "s3") return await s3Get(config.primary, ref.key)
    return await localGet(config.localDir!, ref.key)
  } catch (primaryErr) {
    if (config.replica && ref.replicaKey) {
      if (ref.mode === "s3") return await s3Get(config.replica, ref.replicaKey)
      return await localGet(config.replica.bucket, ref.replicaKey)
    }
    throw primaryErr
  }
}

/**
 * Delete an off-site object if its immutable retention window has elapsed.
 * Returns false (kept) when the object is still under retention.
 */
export async function removeArtifactOffsite(
  ref: Pick<StoredObjectRef, "mode" | "key" | "replicaKey" | "retainUntil" | "immutable">,
  now: Date = new Date(),
): Promise<boolean> {
  const config = offsiteConfig()
  if (!config.primary) return false
  if (!isDeleteAllowed(ref.retainUntil, ref.immutable, now)) return false
  if (ref.mode === "s3") {
    await s3Delete(config.primary, ref.key).catch((err) => console.error("[backup] offsite delete failed", err))
    if (config.replica && ref.replicaKey) await s3Delete(config.replica, ref.replicaKey).catch(() => {})
  } else {
    const ok = await localDelete(config.localDir!, ref.key, now)
    if (!ok) return false
    if (config.replica && ref.replicaKey) await localDelete(config.replica.bucket, ref.replicaKey, now).catch(() => {})
  }
  return true
}

/** Best-effort existence probe used by verification evidence. */
export async function headArtifactOffsite(ref: Pick<StoredObjectRef, "mode" | "key">): Promise<boolean> {
  const config = offsiteConfig()
  if (!config.primary) return false
  try {
    if (ref.mode === "local") {
      await stat(localPath(config.localDir!, ref.key))
      return true
    }
    await s3Get(config.primary, ref.key)
    return true
  } catch {
    return false
  }
}
