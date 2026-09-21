/**
 * Browser-safe projection returned by the storage metadata APIs.
 *
 * This intentionally contains no database imports. Server-side `FileObject`
 * remains the source model; this shape is the serializable contract consumed
 * by storage dashboards.
 */
export type StorageFile = {
  id: number
  fileRef: string
  module: string
  entityType: string | null
  entityId: string | null
  objectKey: string
  provider: string
  filename: string | null
  mimeType: string | null
  size: number
  checksum: string | null
  uploadStatus: string
  version: number
  isCurrent: boolean
  classification: string
  retentionPolicy: string
  retentionExpiresAt: string | null
  legalHold: boolean
  ownerId: number | null
  createdAt: string | null
  updatedAt: string | null
}
