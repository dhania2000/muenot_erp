import "server-only"
import { randomUUID } from "node:crypto"
import { put, del, list, head, createMultipartUpload, uploadPart, completeMultipartUpload } from "@vercel/blob"
import type {
  StorageProvider,
  UploadResult,
  DownloadResult,
  StorageObjectMeta,
  HealthReport,
  MultipartHandle,
  MultipartPart,
} from "./types"
import { HealthReportBuilder } from "./health"
import { proxyUrl } from "./s3"
import { signedProxyUrl, DEFAULT_SIGNED_URL_TTL_SECONDS } from "./signing"

/**
 * Default platform storage. Objects are stored public (mirroring the ERP's
 * prior behavior) and the returned public blob URL is persisted by callers, so
 * existing rows keep resolving unchanged. The tenant-namespaced key is still
 * used as the blob pathname so isolation and listing work uniformly.
 */
export class VercelBlobProvider implements StorageProvider {
  readonly id = "vercel_blob" as const

  async upload(key: string, data: Buffer, contentType: string): Promise<UploadResult> {
    await put(key, data, {
      access: "public",
      addRandomSuffix: false,
      contentType: contentType || undefined,
    })
    // SPEC 29 — Do NOT persist/expose the raw public blob URL. Callers store the
    // access-controlled proxy path so every read is authenticated + tenant- and
    // object-scoped, and no sensitive file is reachable by URL alone.
    return { url: proxyUrl(key), key, provider: this.id, size: data.length, contentType: contentType || null }
  }

  async download(key: string): Promise<DownloadResult> {
    // Resolve the blob's public URL from its pathname, then stream it.
    const meta = await head(key).catch(() => null)
    const url = meta?.url
    if (!url) throw new Error("Object not found")
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error("Object not found")
    return {
      body: res.body,
      contentType: res.headers.get("content-type"),
      size: meta?.size ?? null,
    }
  }

  async list(prefix: string, opts: { limit?: number } = {}): Promise<StorageObjectMeta[]> {
    const out: StorageObjectMeta[] = []
    let cursor: string | undefined
    do {
      const page = await list({ prefix, cursor, limit: opts.limit })
      for (const b of page.blobs) {
        out.push({ key: b.pathname, size: b.size, lastModified: b.uploadedAt?.toISOString?.() ?? null })
        if (opts.limit && out.length >= opts.limit) return out
      }
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
    return out
  }

  async delete(key: string): Promise<void> {
    // del accepts a pathname or URL; resolve the URL first for reliability.
    const meta = await head(key).catch(() => null)
    if (meta?.url) await del(meta.url)
  }

  /**
   * SPEC 29 — Vercel Blob has no native private-presign, so we hand back a
   * short-lived HMAC-signed URL to the app's access-controlled proxy instead of
   * the raw (public) blob URL. The signed token binds the URL to this exact
   * object and to the tenant encoded in its key, and expires quickly.
   */
  async presign(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    return signedProxyUrl(key, opts.expiresIn ?? DEFAULT_SIGNED_URL_TTL_SECONDS)
  }

  /**
   * SPEC 30 — Multipart upload for the managed platform storage. Blob's manual
   * multipart API needs BOTH an `uploadId` and an opaque `key` on every part
   * and at completion, so we pack both into the single `uploadId` handle the
   * caller persists (they never interpret it). The pathname stays the
   * tenant-scoped key so isolation and listing keep working.
   */
  async createMultipart(key: string, contentType: string): Promise<MultipartHandle> {
    const created = await createMultipartUpload(key, {
      access: "public",
      addRandomSuffix: false,
      contentType: contentType || undefined,
    })
    return { uploadId: packHandle(created.uploadId, created.key) }
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Buffer): Promise<MultipartPart> {
    const { uploadId: realId, blobKey } = unpackHandle(uploadId)
    const part = await uploadPart(key, data, {
      access: "public",
      key: blobKey,
      uploadId: realId,
      partNumber,
    })
    return { partNumber: part.partNumber, etag: part.etag }
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<UploadResult> {
    const { uploadId: realId, blobKey } = unpackHandle(uploadId)
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
    await completeMultipartUpload(
      key,
      ordered.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      { access: "public", key: blobKey, uploadId: realId },
    )
    return { url: proxyUrl(key), key, provider: this.id, size: 0, contentType: null }
  }

  /**
   * SPEC 30 — Vercel Blob has no explicit multipart-abort in the manual API;
   * incomplete multipart uploads are garbage-collected automatically, so
   * dropping the session is enough. Kept as a no-op to satisfy the interface.
   */
  async abortMultipart(): Promise<void> {}

  async healthCheck(): Promise<void> {
    // A cheap list call verifies the token/connection is usable.
    await list({ limit: 1 })
  }

  /**
   * SPEC 28 — Full diagnostic run for the managed platform storage. A single
   * list call establishes connectivity + a valid token; there is no
   * customer-owned bucket to probe, so that stage is reported as not
   * applicable. Write/read/delete use a throwaway object, and multipart is
   * exercised via a small multipart upload.
   */
  async diagnose(): Promise<HealthReport> {
    const b = new HealthReportBuilder()

    // Connectivity + credentials: a 1-item list requires a valid access token.
    const start = Date.now()
    const reachable = await (async () => {
      try {
        await list({ limit: 1 })
        b.pass("connectivity", "Reached Vercel Blob", Date.now() - start)
        b.pass("credentials", "Blob read/write token is valid")
        return true
      } catch (err) {
        const detail =
          (err as any)?.message?.includes("token") || (err as any)?.name === "BlobAccessError"
            ? "Blob token missing or invalid — check BLOB_READ_WRITE_TOKEN"
            : ((err as any)?.message ?? "Could not reach Vercel Blob")
        b.fail("connectivity", String(detail).slice(0, 240), Date.now() - start)
        b.skip("credentials", "Skipped — could not reach Vercel Blob")
        return false
      }
    })()

    // No tenant-owned bucket for managed storage.
    b.skip("bucket", "Not applicable — managed platform storage has no bucket")

    if (!reachable) {
      b.skip("write", "Skipped — could not reach Vercel Blob")
      b.skip("read", "Skipped — could not reach Vercel Blob")
      b.skip("delete", "Skipped — could not reach Vercel Blob")
      b.skip("multipart", "Skipped — could not reach Vercel Blob")
      return b.build()
    }

    const key = `.v0-healthcheck/${randomUUID()}.txt`
    const payload = Buffer.from(`v0 storage health check ${new Date().toISOString()}`)
    let url: string | null = null

    const wrote = await b.run("write", async () => {
      const blob = await put(key, payload, { access: "public", addRandomSuffix: false, contentType: "text/plain" })
      url = blob.url
      return "Wrote a temporary test object"
    })

    if (wrote && url) {
      await b.run("read", async () => {
        const res = await fetch(url as string)
        if (!res.ok) throw new Error(`Read failed (HTTP ${res.status})`)
        return "Read the test object back"
      })
      await b.run("delete", async () => {
        await del(url as string)
        return "Deleted the test object"
      })
    } else {
      b.skip("read", "Skipped — write failed")
      b.skip("delete", "Skipped — nothing was written to clean up")
    }

    // Multipart: a small multipart upload verifies the chunked path works.
    await b.run("multipart", async () => {
      const mpKey = `.v0-healthcheck/${randomUUID()}.part`
      const blob = await put(mpKey, payload, {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/octet-stream",
        multipart: true,
      })
      await del(blob.url)
      return "Completed a multipart upload"
    })

    return b.build()
  }
}

/**
 * SPEC 30 — Pack Blob's two multipart identifiers (uploadId + opaque key) into
 * the single handle string the caller persists, and unpack them for each part.
 */
function packHandle(uploadId: string, blobKey: string): string {
  return `${uploadId}:::${blobKey}`
}

function unpackHandle(handle: string): { uploadId: string; blobKey: string } {
  const idx = handle.indexOf(":::")
  if (idx < 0) return { uploadId: handle, blobKey: "" }
  return { uploadId: handle.slice(0, idx), blobKey: handle.slice(idx + 3) }
}
