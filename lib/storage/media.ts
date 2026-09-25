/**
 * Streaming media catalog (Spec11 — video streaming & CDN).
 * ---------------------------------------------------------------------------
 * A thin, tenant-scoped read/stream/purge layer over the EXISTING storage
 * subsystem. It deliberately does NOT introduce a new upload path, signer, or
 * provider abstraction — monitoring/training videos are uploaded through the
 * resumable multipart flow (`beginLargeUpload` / part / `completeLargeUpload`)
 * and recorded in `file_objects` like every other object.
 *
 * What this module adds on top:
 *   - a filtered view of a tenant's monitoring/training *media* (video / audio /
 *     image) objects,
 *   - minting of short-lived signed STREAMING URLs that support HTTP Range
 *     (seek) by delegating to `getSignedDownloadUrl` -> provider presign, which
 *     also runs the malware / quarantine gate,
 *   - provider-aware CDN origin selection that never routes a private session
 *     through a shared cache,
 *   - purge (physical delete + metadata soft-delete) honouring legal hold.
 *
 * Every function relies on the ambient tenant scope (AsyncLocalStorage) already
 * used throughout the storage layer, so cross-tenant reads/streams/deletes are
 * impossible even if an attacker guesses another tenant's numeric id.
 */

import "server-only"

import {
  deleteFile,
  getFileById,
  getSignedDownloadUrl,
  listFileMetadata,
  type FileObject,
} from "./index"
import { getActiveConnection } from "./connection-store"
import { cdnOriginUrl, mediaKindFor, isRangeable, type DeliveryAccess, type MediaKind } from "./cdn"

/** ERP modules whose objects count as streamable monitoring / training media. */
export const MEDIA_MODULES = [
  "hr.screen_monitoring",
  "training",
  "lms",
] as const

/** Default streaming-URL lifetime (seconds); overridable via env, capped hard. */
const DEFAULT_STREAM_TTL = envInt("STORAGE_MEDIA_STREAM_TTL", 300) // 5 min
const MAX_STREAM_TTL = envInt("STORAGE_MEDIA_STREAM_TTL_MAX", 3600) // 1 hour

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** A media object plus its derived streaming attributes. */
export type MediaAsset = FileObject & {
  kind: MediaKind
  /** True when the kind benefits from Range (video/audio) — i.e. seekable. */
  seekable: boolean
}

function isMediaKind(kind: MediaKind): boolean {
  return kind === "video" || kind === "audio" || kind === "image"
}

function toMediaAsset(file: FileObject): MediaAsset {
  const kind = mediaKindFor(file.mimeType, file.objectKey)
  return { ...file, kind, seekable: isRangeable(kind) }
}

export type ListMediaFilter = {
  module?: string
  entityType?: string
  entityId?: string | number
  /** Only these kinds (defaults to video+audio+image). */
  kinds?: MediaKind[]
  limit?: number
}

/**
 * List the current tenant's media assets. When no module is supplied we union
 * the known monitoring/training modules; results are always tenant-scoped by
 * the underlying `listFileMetadata`.
 */
export async function listMediaAssets(filter: ListMediaFilter = {}): Promise<MediaAsset[]> {
  const kinds = filter.kinds && filter.kinds.length > 0 ? filter.kinds : (["video", "audio", "image"] as MediaKind[])
  const wantKind = (k: MediaKind) => kinds.includes(k)

  const modules = filter.module ? [filter.module] : [...MEDIA_MODULES]
  const seen = new Set<number>()
  const out: MediaAsset[] = []

  for (const module of modules) {
    const rows = await listFileMetadata({
      module,
      entityType: filter.entityType,
      entityId: filter.entityId,
      currentOnly: true,
      limit: filter.limit ?? 200,
    })
    for (const row of rows) {
      if (seen.has(row.id)) continue
      const asset = toMediaAsset(row)
      if (!isMediaKind(asset.kind) || !wantKind(asset.kind)) continue
      seen.add(row.id)
      out.push(asset)
    }
  }

  out.sort((a, b) => b.id - a.id)
  return filter.limit ? out.slice(0, filter.limit) : out
}

/** Fetch one media asset by id (tenant-scoped). Returns null for non-media or foreign rows. */
export async function getMediaAsset(id: number): Promise<MediaAsset | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const file = await getFileById(id)
  if (!file) return null
  const asset = toMediaAsset(file)
  if (!isMediaKind(asset.kind)) return null
  return asset
}

/** Whether a media asset should be delivered publicly (only explicit "public" classification). */
function deliveryAccessFor(asset: MediaAsset): DeliveryAccess {
  return asset.classification === "public" ? "public" : "signed"
}

export type MediaStreamUrl = {
  assetId: number
  url: string
  /** Delivery mode used to build the URL. */
  access: DeliveryAccess
  /** Seconds until the signed URL expires (null for a permanent public URL). */
  expiresIn: number | null
  kind: MediaKind
  mimeType: string | null
  filename: string | null
  /** True when the delivery supports HTTP Range requests (seek). */
  seekable: boolean
}

/**
 * Mint a short-lived signed streaming URL for a media asset.
 *
 * Delegates to `getSignedDownloadUrl`, which:
 *   - re-checks tenant ownership of the key,
 *   - enforces the download policy (blocks quarantined / un-scanned objects),
 *   - returns a signed proxy URL whose backing route already supports Range.
 *
 * For an explicitly `public` asset with a configured CDN origin we return the
 * public CDN URL; private assets are ALWAYS served from the signed proxy so a
 * private session can never be cached by a shared CDN.
 *
 * Throws (propagated from the storage layer) when the asset is quarantined,
 * cross-tenant, or the provider cannot sign — callers map these to 403/404/502.
 */
export async function getMediaStreamUrl(
  id: number,
  opts: { expiresIn?: number } = {},
): Promise<{ ok: true; stream: MediaStreamUrl } | { ok: false; error: string; status: number }> {
  const asset = await getMediaAsset(id)
  if (!asset) return { ok: false, error: "Media asset not found", status: 404 }
  if (asset.uploadStatus !== "completed") {
    return { ok: false, error: "Media is still processing", status: 409 }
  }

  const ttl = Math.min(MAX_STREAM_TTL, Math.max(30, Math.floor(opts.expiresIn ?? DEFAULT_STREAM_TTL)))
  const access = deliveryAccessFor(asset)

  let signed: string
  try {
    signed = await getSignedDownloadUrl(asset.fileRef, { expiresIn: ttl })
  } catch (err: any) {
    // enforceDownloadPolicyForKey throws for quarantined/blocked objects.
    const message = String(err?.message || "")
    if (/cross|not found|belongs/i.test(message)) return { ok: false, error: "Media asset not found", status: 404 }
    return { ok: false, error: "Media is not available for streaming yet", status: 403 }
  }

  const connection = await getActiveConnection().catch(() => null)
  const url = cdnOriginUrl({
    access,
    key: asset.objectKey,
    signedOrProxyUrl: signed,
    publicBaseUrl: connection?.publicBaseUrl ?? null,
  })

  return {
    ok: true,
    stream: {
      assetId: asset.id,
      url,
      access,
      expiresIn: access === "public" ? null : ttl,
      kind: asset.kind,
      mimeType: asset.mimeType,
      filename: asset.filename,
      seekable: asset.seekable,
    },
  }
}

/**
 * Purge a media asset: delete the physical object and soft-delete its metadata.
 * Delegates to `deleteFile`, which refuses when a legal hold is active and is
 * tenant-scoped. Returns a structured result for the route to audit.
 */
export async function purgeMediaAsset(
  id: number,
): Promise<{ ok: true; asset: MediaAsset } | { ok: false; error: string; status: number }> {
  const asset = await getMediaAsset(id)
  if (!asset) return { ok: false, error: "Media asset not found", status: 404 }
  if (asset.legalHold) return { ok: false, error: "Media is under legal hold and cannot be deleted", status: 409 }
  try {
    await deleteFile(asset.fileRef)
  } catch (err: any) {
    const message = String(err?.message || "")
    if (/legal hold/i.test(message)) return { ok: false, error: "Media is under legal hold and cannot be deleted", status: 409 }
    if (/cross|not found|belongs/i.test(message)) return { ok: false, error: "Media asset not found", status: 404 }
    console.error("[v0] purgeMediaAsset failed:", err)
    return { ok: false, error: "Could not delete media", status: 502 }
  }
  return { ok: true, asset }
}
