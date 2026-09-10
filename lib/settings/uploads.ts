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
  const { maxBytes, maxMb, extensions, mimeTypes } = await getUploadLimits()
  if (file.size > maxBytes) return `File must be ${maxMb}MB or smaller`
  if (extensions.length > 0) {
    const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : ""
    const extOk = extensions.includes(ext)
    // Fall back to the MIME check when we have a mapping, so a renamed file
    // still passes on a legitimate content type.
    const mimeOk = mimeTypes.size > 0 && mimeTypes.has(file.type)
    if (!extOk && !mimeOk) return `Allowed file types: ${extensions.join(", ")}`
  }
  return null
}
