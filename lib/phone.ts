// Phone number helpers for call logging.
//
// Optional env var:
//   CALL_DEFAULT_COUNTRY_CODE - dialing code applied to local numbers, e.g. +91

/**
 * Normalize a raw phone number to E.164 as best we can. Numbers that already
 * start with "+" are trusted as-is; bare local numbers get the default country
 * code prepended.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "")
    return digits ? `+${digits}` : null
  }
  const digits = trimmed.replace(/\D/g, "")
  if (!digits) return null
  const cc = (process.env.CALL_DEFAULT_COUNTRY_CODE || "+91").replace(/\D/g, "")
  if (digits.startsWith(cc) && digits.length > 10) return `+${digits}`
  return `+${cc}${digits}`
}
