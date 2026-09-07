import twilio from "twilio"

// Twilio Voice (in-browser VoIP) configuration.
// Configure these via environment variables (.env.local locally, or your
// hosting panel / .env in production).
//
// Required env vars:
//   TWILIO_ACCOUNT_SID     - starts with "AC..."
//   TWILIO_AUTH_TOKEN      - account auth token (used for REST reconciliation)
//   TWILIO_API_KEY         - a Standard API Key SID ("SK...")
//   TWILIO_API_SECRET      - the API Key secret (shown once at creation)
//   TWILIO_TWIML_APP_SID   - a TwiML App SID ("AP...") whose Voice URL points
//                            at /api/sales/calls/voice
//   TWILIO_CALLER_ID       - a Twilio phone number in E.164, e.g. +14155551234
// Optional:
//   TWILIO_DEFAULT_COUNTRY_CODE - dialing code applied to local numbers, e.g. +91

export function isCallingConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_API_KEY &&
      process.env.TWILIO_API_SECRET &&
      process.env.TWILIO_TWIML_APP_SID &&
      process.env.TWILIO_CALLER_ID,
  )
}

export function getCallerId() {
  return process.env.TWILIO_CALLER_ID || ""
}

/**
 * Build a short-lived Voice access token so the browser SDK (Device) can place
 * outbound calls routed through our TwiML App.
 */
export function createVoiceToken(identity: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID as string
  const apiKey = process.env.TWILIO_API_KEY as string
  const apiSecret = process.env.TWILIO_API_SECRET as string
  const appSid = process.env.TWILIO_TWIML_APP_SID as string

  const AccessToken = twilio.jwt.AccessToken
  const VoiceGrant = AccessToken.VoiceGrant

  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: false,
  })

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity,
    ttl: 3600,
  })
  token.addGrant(grant)
  return token.toJwt()
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
  const cc = (process.env.TWILIO_DEFAULT_COUNTRY_CODE || "+91").replace(/\D/g, "")
  // If the number already includes the country code length heuristically, still
  // prefix the configured code unless it clearly already starts with it.
  if (digits.startsWith(cc) && digits.length > 10) return `+${digits}`
  return `+${cc}${digits}`
}

/** REST client for reconciling call status/duration after the fact. */
export function getRestClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) return null
  return twilio(accountSid, authToken)
}
