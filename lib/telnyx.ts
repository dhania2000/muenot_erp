// Telnyx Voice API (in-browser WebRTC) configuration.
// Pricing / API: https://telnyx.com/pricing/voice-api
//
// The browser dials with the Telnyx WebRTC SDK (@telnyx/webrtc). It logs in
// with a short-lived JWT that we mint on the server from a Telnyx Telephony
// Credential, then places outbound PSTN calls through that credential's
// Voice API / SIP connection.
//
// Required env vars:
//   TELNYX_API_KEY         - server API key, starts with "KEY..."
//   TELNYX_CREDENTIAL_ID   - a Telephony Credential ID tied to a Voice API
//                            (or Credential/SIP) connection that allows
//                            outbound calls
//   TELNYX_CALLER_ID       - a Telnyx number in E.164, e.g. +14155551234
// Optional:
//   TELNYX_DEFAULT_COUNTRY_CODE - dialing code applied to local numbers, e.g. +91

const TELNYX_API_BASE = "https://api.telnyx.com/v2"

export function isCallingConfigured() {
  return Boolean(
    process.env.TELNYX_API_KEY &&
      process.env.TELNYX_CREDENTIAL_ID &&
      process.env.TELNYX_CALLER_ID,
  )
}

export function getCallerId() {
  return process.env.TELNYX_CALLER_ID || ""
}

/**
 * Mint a short-lived on-demand access token (JWT) for the browser WebRTC SDK
 * from a Telnyx Telephony Credential. The SDK uses it as `login_token`.
 *
 * Telnyx returns the token as a plain-text response body.
 */
export async function createVoiceToken(_identity?: string): Promise<string> {
  const apiKey = process.env.TELNYX_API_KEY as string
  const credentialId = process.env.TELNYX_CREDENTIAL_ID as string

  const res = await fetch(`${TELNYX_API_BASE}/telephony_credentials/${credentialId}/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Telnyx token request failed (${res.status}): ${detail}`)
  }

  const token = (await res.text()).trim()
  if (!token) throw new Error("Telnyx returned an empty voice token")
  return token
}

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
  const cc = (process.env.TELNYX_DEFAULT_COUNTRY_CODE || "+91").replace(/\D/g, "")
  if (digits.startsWith(cc) && digits.length > 10) return `+${digits}`
  return `+${cc}${digits}`
}
