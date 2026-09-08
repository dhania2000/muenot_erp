// Telnyx Voice (in-browser VoIP) configuration.
// Configure these via environment variables (.env.local locally, or your
// hosting panel / .env in production).
//
// Required env vars:
//   TELNYX_API_KEY               - your Telnyx API v2 key ("KEY...")
//   TELNYX_SIP_CONNECTION_ID     - the Credential Connection ID that the
//                                  on-demand credential is created under; this
//                                  connection must have outbound voice enabled
//                                  and be assigned an outbound voice profile.
//   TELNYX_CALLER_ID             - a Telnyx phone number in E.164, e.g.
//                                  +14155551234 (used as the "from" number)
// Optional:
//   TELNYX_DEFAULT_COUNTRY_CODE  - dialing code applied to local numbers, e.g. +91

const TELNYX_API = "https://api.telnyx.com/v2"

export function isCallingConfigured() {
  return Boolean(
    process.env.TELNYX_API_KEY &&
      process.env.TELNYX_SIP_CONNECTION_ID &&
      process.env.TELNYX_CALLER_ID,
  )
}

export function getCallerId() {
  return process.env.TELNYX_CALLER_ID || ""
}

async function telnyxFetch(path: string, init?: RequestInit) {
  const apiKey = process.env.TELNYX_API_KEY as string
  const res = await fetch(`${TELNYX_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
  return res
}

/**
 * Mint a short-lived WebRTC token so the browser SDK (TelnyxRTC) can register
 * and place outbound calls. Telnyx issues these in two steps:
 *   1. create an on-demand telephony credential bound to our SIP connection
 *   2. exchange that credential for a JWT the browser can use
 * The returned token is what the browser passes to `new TelnyxRTC({ login_token })`.
 */
export async function createVoiceToken(identity: string): Promise<string> {
  const connectionId = process.env.TELNYX_SIP_CONNECTION_ID as string

  // 1) Create an on-demand telephony credential under the SIP connection.
  const credRes = await telnyxFetch("/telephony_credentials", {
    method: "POST",
    body: JSON.stringify({
      connection_id: connectionId,
      name: `webrtc-${identity}-${Date.now()}`,
      // Credential auto-expires so we don't accumulate stale SIP creds.
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  })
  if (!credRes.ok) {
    const detail = await credRes.text().catch(() => "")
    throw new Error(`Failed to create telephony credential: ${credRes.status} ${detail}`)
  }
  const credJson = await credRes.json()
  const credentialId = credJson?.data?.id
  if (!credentialId) throw new Error("Telnyx did not return a credential id")

  // 2) Exchange the credential for a short-lived WebRTC JWT.
  const tokenRes = await telnyxFetch(`/telephony_credentials/${credentialId}/token`, {
    method: "POST",
  })
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "")
    throw new Error(`Failed to mint WebRTC token: ${tokenRes.status} ${detail}`)
  }
  // This endpoint returns the JWT as a raw text body.
  const token = (await tokenRes.text()).trim()
  if (!token) throw new Error("Telnyx returned an empty WebRTC token")
  return token
}

/**
 * Normalize a raw lead phone number to E.164 as best we can. Numbers that
 * already start with "+" are trusted as-is; bare local numbers get the default
 * country code prepended.
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
