import "server-only"
import { put, del, list, head } from "@vercel/blob"
import type { StorageProvider, UploadResult, DownloadResult, StorageObjectMeta } from "./types"

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
}
