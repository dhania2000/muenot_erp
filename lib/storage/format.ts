/**
 * Browser-safe storage display helpers.
 *
 * Keep these values separate from `storage-quota.ts`: that module resolves
 * tenant plans and queries MySQL, while dashboards need only deterministic
 * formatting and must never pull server-only code into the browser bundle.
 */
export const BYTES_PER_GB = 1024 * 1024 * 1024

export function gbToBytes(gb: number): number {
  return Math.max(0, Math.floor(gb * BYTES_PER_GB))
}

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, index)
  const rounded = value >= 100 || index === 0 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${units[index]}`
}
