import "server-only"
import { getNum, getSetting } from "@/lib/settings/server"

// Maps the extensions from the "Allowed File Types" setting to the MIME types a
// browser reports, so an upload can be validated against either signal.
const EXT_MIME: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  svg: ["image/svg+xml"],
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  csv: ["text/csv", "application/vnd.ms-excel"],
  txt: ["text/plain"],
  zip: ["application/zip", "application/x-zip-compressed"],
}

export type UploadLimits = {
  maxBytes: number
  maxMb: number
  extensions: string[]
  mimeTypes: Set<string>
}

/** Effective upload limits from the storage settings section. */
export async function getUploadLimits(): Promise<UploadLimits> {
  const maxMb = await getNum("storage.max_upload_mb", 25)
  const raw = await getSetting("storage.allowed_types")
  const extensions = raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
  const mimeTypes = new Set<string>()
  for (const ext of extensions) for (const m of EXT_MIME[ext] ?? []) mimeTypes.add(m)
  return { maxBytes: Math.max(1, maxMb) * 1024 * 1024, maxMb, extensions, mimeTypes }
}

/**
 * Validates a file against the configured size and type limits.
 * Returns a user-facing error message, or null when the file is allowed.
 */
export async function validateUpload(file: File): Promise<string | null> {
  return validateUploadMeta({ name: file.name, size: file.size, type: file.type })
}

/**
 * SPEC 30 — Validate an upload from its metadata alone (name/size/type),
 * without needing the bytes in memory. This is what the multipart "create
 * session" step uses: a huge video/ZIP is never buffered server-side, so we
 * must be able to accept or reject it before the first chunk arrives.
 */
export async function validateUploadMeta(meta: {
  name: string
  size: number
  type?: string | null
}): Promise<string | null> {
  const { maxBytes, maxMb, extensions, mimeTypes } = await getUploadLimits()
  if (meta.size > maxBytes) return `File must be ${maxMb}MB or smaller`
  if (extensions.length > 0) {
    const ext = meta.name.includes(".") ? meta.name.split(".").pop()!.toLowerCase() : ""
    const extOk = extensions.includes(ext)
    const mimeOk = mimeTypes.size > 0 && !!meta.type && mimeTypes.has(meta.type)
    if (!extOk && !mimeOk) return `Allowed file types: ${extensions.join(", ")}`
  }
  return null
}

/**
 * SPEC 30 — Large-file limits for resumable multipart uploads. These files
 * (videos, ZIPs, training/employee bundles) are far bigger than the ordinary
 * single-request cap, so they get their own, higher ceiling and are NOT bound
 * by the `allowed_types` list (which targets small inline documents/images).
 */
export type LargeUploadLimits = {
  maxBytes: number
  maxMb: number
  /** Fixed chunk size the client and server agree on (bytes). */
  partSize: number
  /** Provider floor: every part except the last must be ≥ 5 MiB. */
  minPartSize: number
  maxParts: number
}

const MIB = 1024 * 1024

export async function getLargeUploadLimits(): Promise<LargeUploadLimits> {
  // Default 5 GiB; admins can raise/lower it in Storage Settings.
  const maxMb = await getNum("storage.max_multipart_mb", 5120)
  const partSize = 8 * MIB // 8 MiB chunks — comfortably above the 5 MiB floor.
  return {
    maxBytes: Math.max(1, maxMb) * MIB,
    maxMb,
    partSize,
    minPartSize: 5 * MIB,
    maxParts: 10000,
  }
}

/**
 * Validate a large multipart upload request from its declared metadata. Returns
 * a user-facing error string, or null when the request is acceptable.
 */
export async function validateLargeUpload(meta: {
  name: string
  size: number
}): Promise<string | null> {
  const { maxBytes, maxMb } = await getLargeUploadLimits()
  if (!meta.name?.trim()) return "A file name is required"
  if (!Number.isFinite(meta.size) || meta.size <= 0) return "A valid file size is required"
  if (meta.size > maxBytes) return `File must be ${maxMb}MB or smaller`
  return null
}
