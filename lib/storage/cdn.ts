/**
 * CDN / media delivery abstraction.
 * ---------------------------------------------------------------------------
 * A pure, dependency-free policy layer that decides HOW an object is delivered
 * over HTTP so the response is correct AND cache/CDN-friendly:
 *
 *   - classifies an object into a media kind (video / image / audio / document)
 *     from its content-type and key,
 *   - derives the right `Cache-Control` for the delivery context (a capability-
 *     bearing signed URL can be cached for the life of its token; an
 *     interactively-browsed private object must not be stored by shared caches),
 *   - derives `Content-Disposition` (inline for media, attachment for document
 *     downloads),
 *   - centralises the tunables (per-kind max-age) with env overrides.
 *
 * Kept free of `server-only` and any SDK import so it is trivially unit-tested
 * and usable from both the download proxy and upload result shaping.
 */

export type MediaKind = "video" | "image" | "audio" | "document" | "other"

export type DeliveryAccess =
  /** Capability-bearing, time-limited signed URL (safe to cache per-URL). */
  | "signed"
  /** Interactive session browsing (per-request auth, never shared-cache). */
  | "session"
  /** Explicitly public object served from a public bucket / CDN origin. */
  | "public"

/** Default per-kind browser/CDN max-age (seconds) for cacheable deliveries. */
const DEFAULTS = {
  image: 60 * 60 * 24 * 30, // 30 days — images are effectively immutable per key
  video: 60 * 60 * 24 * 7, //  7 days
  audio: 60 * 60 * 24 * 7, //  7 days
  document: 60 * 60, //  1 hour — documents change more often
  other: 60 * 5, //  5 minutes
} as const

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** Resolved cache policy (env-overridable) for each media kind. */
export function cdnMaxAge(kind: MediaKind): number {
  switch (kind) {
    case "image":
      return envInt("STORAGE_CDN_IMAGE_MAX_AGE", DEFAULTS.image)
    case "video":
      return envInt("STORAGE_CDN_VIDEO_MAX_AGE", DEFAULTS.video)
    case "audio":
      return envInt("STORAGE_CDN_AUDIO_MAX_AGE", DEFAULTS.audio)
    case "document":
      return envInt("STORAGE_CDN_DOCUMENT_MAX_AGE", DEFAULTS.document)
    default:
      return envInt("STORAGE_CDN_DEFAULT_MAX_AGE", DEFAULTS.other)
  }
}

const EXT_KIND: Record<string, MediaKind> = {
  // images
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  avif: "image", svg: "image", bmp: "image", ico: "image", heic: "image", heif: "image",
  // video
  mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video",
  avi: "video", ogv: "video", mpeg: "video", mpg: "video",
  // audio
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", m4a: "audio", aac: "audio", flac: "audio",
  // documents
  pdf: "document", doc: "document", docx: "document", xls: "document", xlsx: "document",
  ppt: "document", pptx: "document", csv: "document", txt: "document", rtf: "document",
  zip: "document", rar: "document", "7z": "document", gz: "document",
}

/** Best-effort media classification from content-type first, then key extension. */
export function mediaKindFor(contentType: string | null | undefined, key?: string | null): MediaKind {
  const ct = (contentType || "").toLowerCase()
  if (ct.startsWith("image/")) return "image"
  if (ct.startsWith("video/")) return "video"
  if (ct.startsWith("audio/")) return "audio"
  if (
    ct === "application/pdf" ||
    ct.startsWith("text/") ||
    ct.includes("word") ||
    ct.includes("excel") ||
    ct.includes("spreadsheet") ||
    ct.includes("presentation") ||
    ct.includes("officedocument") ||
    ct === "application/zip" ||
    ct === "application/x-zip-compressed" ||
    ct === "text/csv"
  ) {
    return "document"
  }
  if (key) {
    const ext = key.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase()
    if (ext && EXT_KIND[ext]) return EXT_KIND[ext]
  }
  return "other"
}

/**
 * Build the `Cache-Control` header for a delivery.
 *
 * - `signed`  — the signature IS the access token and it is baked into the URL,
 *   so the response is safely cacheable keyed on the full (signed) URL. We cap
 *   the freshness at the token's remaining lifetime so a cached copy can never
 *   outlive the grant. Marked `private` because the content is still per-tenant.
 * - `public`  — public bucket/CDN origin: cacheable in shared caches, immutable.
 * - `session` — interactive, per-request-authenticated read: never stored by a
 *   shared or disk cache.
 */
export function cacheControlFor(opts: {
  access: DeliveryAccess
  kind: MediaKind
  /** For `signed`: seconds left before the URL's token expires. */
  remainingTtlSeconds?: number | null
}): string {
  const { access, kind } = opts
  if (access === "session") {
    return "private, no-store, max-age=0, must-revalidate"
  }
  if (access === "public") {
    const maxAge = cdnMaxAge(kind)
    return `public, max-age=${maxAge}, immutable`
  }
  // signed
  const policyMax = cdnMaxAge(kind)
  const ttl = opts.remainingTtlSeconds
  const maxAge = ttl != null && Number.isFinite(ttl) ? Math.max(0, Math.min(policyMax, Math.floor(ttl))) : policyMax
  // `private` keeps it out of shared caches (still per-tenant content) while
  // letting the browser and any per-user CDN edge cache reuse the exact URL.
  return `private, max-age=${maxAge}`
}

/** RFC 5987 / 6266-safe filename for Content-Disposition. */
function encodeFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  const utf8 = encodeURIComponent(name)
  return `filename="${fallback}"; filename*=UTF-8''${utf8}`
}

/**
 * Build the `Content-Disposition` header. Documents (and any explicit download
 * request) are sent as an attachment so the browser saves rather than tries to
 * render them; media is served inline so <img>/<video>/<audio> and PDF viewers
 * work. `filename` is optional but recommended for downloads.
 */
export function contentDispositionFor(opts: {
  kind: MediaKind
  filename?: string | null
  forceDownload?: boolean
}): string {
  const asAttachment = opts.forceDownload === true || (opts.forceDownload !== false && opts.kind === "document")
  const disposition = asAttachment ? "attachment" : "inline"
  if (opts.filename) return `${disposition}; ${encodeFilename(opts.filename)}`
  return disposition
}

/** True when a media kind benefits from HTTP Range (seekable) delivery. */
export function isRangeable(kind: MediaKind): boolean {
  return kind === "video" || kind === "audio"
}

/**
 * Resolve the final delivery URL for an object, honouring the tenant's
 * provider-specific CDN origin — WITHOUT ever routing a private session through
 * a shared cache.
 *
 * The rule the ERP relies on for private monitoring/training media:
 *   - `public`  objects MAY be served from the connection's CDN/public base URL
 *     (`publicBaseUrl`) so a shared CDN edge can cache them; when no origin is
 *     configured we fall back to the app's own proxy path.
 *   - `signed` / `session` deliveries are per-tenant and time-boxed. They MUST
 *     be served from the signed URL as-is (the app proxy or a native presigned
 *     URL). We never rewrite them onto the public CDN origin, so a private video
 *     session can never land in a publicly-shared cache.
 *
 * Pure and dependency-free; the caller decides `access` from how the request was
 * authorized. Returns `signedOrProxyUrl` unchanged for anything private.
 */
export function cdnOriginUrl(opts: {
  access: DeliveryAccess
  /** Tenant-namespaced object key (no leading slash). */
  key: string
  /** The signed proxy URL or native presigned URL already minted for the object. */
  signedOrProxyUrl: string
  /** The connection's configured CDN/public base URL, if any. */
  publicBaseUrl?: string | null
}): string {
  const { access, key, signedOrProxyUrl, publicBaseUrl } = opts
  // Private deliveries are never rewritten onto a shared CDN origin.
  if (access !== "public") return signedOrProxyUrl
  const base = (publicBaseUrl || "").trim().replace(/\/+$/, "")
  if (!base) return signedOrProxyUrl
  const cleanKey = key.replace(/^\/+/, "")
  return `${base}/${cleanKey}`
}

/** Derive a human filename from a storage key (last path segment). */
export function filenameFromKey(key: string): string {
  const seg = key.split("?")[0].split("/").filter(Boolean).pop() || "download"
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}
