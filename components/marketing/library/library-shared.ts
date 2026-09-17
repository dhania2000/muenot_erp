export type LibraryAsset = {
  id: number
  assetId: string
  name: string
  fileName: string
  assetType: string
  category: string | null
  subcategory: string | null
  description: string | null
  tags: string[]
  folderId: number | null
  folderPath: string | null
  version: number
  status: string
  ownerEmployeeId: string | null
  ownerName: string | null
  department: string | null
  fileSize: number
  fileSizeLabel: string
  fileType: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  pageCount: number | null
  usageCount: number
  expiryDate: string | null
  usageRights: string | null
  copyright: string | null
  license: string | null
  attribution: string | null
  restrictions: string | null
  licenseExpiry: string | null
  source: string
  externalRef: string | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  kind: "image" | "video" | "audio" | "pdf" | "document" | "other"
  previewUrl: string
  downloadUrl: string
}

export type LibraryFolder = {
  id: number
  name: string
  parent_id: number | null
  path: string
  restricted: number
  allowed_roles: string[] | null
  asset_count: number
}

export type StorageStats = {
  usedBytes: number
  quotaBytes: number
  percentage: number
  assetCount: number
  largest: { asset_id: string; name: string; file_size: number }[]
}

export type AssetVersion = {
  id: number
  version: number
  file_name: string
  file_type: string | null
  file_size: number
  width: number | null
  height: number | null
  change_note: string | null
  uploaded_by_name: string | null
  uploaded_at: string
}

export type AssetUsage = {
  id: number
  module: string
  ref_id: string
  ref_label: string | null
  created_at: string
}

export type AssetAudit = {
  action: string
  detail: string | null
  user_name: string | null
  created_at: string
}

export const ASSET_TYPES = [
  "Image",
  "Document",
  "Video",
  "Audio",
  "PDF",
  "Presentation",
  "Spreadsheet",
  "Email Template",
  "Landing Page",
  "Logo",
  "Brand Asset",
  "Creative",
  "Brochure",
  "Case Study",
  "Whitepaper",
  "Social Creative",
  "Other",
]

export const ASSET_CATEGORIES = [
  "Brand",
  "Social Media",
  "Email",
  "Website",
  "Campaigns",
  "Sales",
  "Recruitment",
  "Events",
  "Corporate",
  "Documents",
  "Presentations",
  "Video",
  "Design",
  "Other",
]

export const ASSET_STATUSES = ["Draft", "Active", "Archived", "Expired", "Restricted"]

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "updated", label: "Last Updated" },
  { value: "created", label: "Date Created" },
  { value: "name", label: "Name" },
  { value: "size", label: "File Size" },
  { value: "usage", label: "Usage Count" },
  { value: "version", label: "Version" },
]

export const jsonFetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Request failed")
    return r.json()
  })

export function humanBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "Active":
      return "default"
    case "Draft":
      return "secondary"
    case "Restricted":
      return "destructive"
    default:
      return "outline"
  }
}
