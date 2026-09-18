import "server-only"
import { randomUUID } from "node:crypto"
import { put, del, list, head } from "@vercel/blob"
import type { StorageProvider, UploadResult, DownloadResult, StorageObjectMeta, HealthReport } from "./types"
import { HealthReportBuilder } from "./health"

/**
 * Default platform storage. Objects are stored public (mirroring the ERP's
 * prior behavior) and the returned public blob URL is persisted by callers, so
 * existing rows keep resolving unchanged. The tenant-namespaced key is still
 * used as the blob pathname so isolation and listing work uniformly.
 */
export class VercelBlobProvider implements StorageProvider {
  readonly id = "vercel_blob" as const

  async upload(key: string, data: Buffer, contentType: string): Promise<UploadResult> {
    const blob = await put(key, data, {
      access: "public",
      addRandomSuffix: false,
      contentType: contentType || undefined,
    })
    return { url: blob.url, key, provider: this.id, size: data.length, contentType: contentType || null }
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
