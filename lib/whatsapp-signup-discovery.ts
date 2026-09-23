import "server-only"
import { GRAPH_VERSION, getAppId, getAppSecret } from "@/lib/whatsapp"

export class SignupDiscoveryError extends Error {
  constructor(public code: "WABA_ID_MISSING" | "PHONE_NUMBER_ID_MISSING" | "WABA_MISMATCH" | "PHONE_MISMATCH" | "META_DISCOVERY_FAILED") {
    super(code)
  }
}

const validId = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

/** Resolve assets from the exchanged token, never from an unverified browser ID alone. */
export async function discoverSignupAssets(accessToken: string, input: {
  wabaId?: string; phoneNumberId?: string; businessId?: string
}) {
  const appId = getAppId()
  const appSecret = getAppSecret()
  if (!appId || !appSecret) throw new SignupDiscoveryError("META_DISCOVERY_FAILED")
  const root = `https://graph.facebook.com/${GRAPH_VERSION}`
  let details: { data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }
  try {
    const url = new URL(`${root}/debug_token`)
    url.searchParams.set("input_token", accessToken)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${appId}|${appSecret}` }, cache: "no-store", signal: AbortSignal.timeout(15000),
    })
    details = await response.json()
    if (!response.ok) throw new Error("Meta debug_token failed")
  } catch { throw new SignupDiscoveryError("META_DISCOVERY_FAILED") }

  const authorizedWabas = [...new Set((details.data?.granular_scopes ?? [])
    .filter(scope => scope.scope === "whatsapp_business_management" || scope.scope === "whatsapp_business_messaging")
    .flatMap(scope => scope.target_ids ?? []).filter(validId))]
  const wabaId = input.wabaId || (authorizedWabas.length === 1 ? authorizedWabas[0] : undefined)
  if (!wabaId) throw new SignupDiscoveryError("WABA_ID_MISSING")
  if (!validId(wabaId) || (authorizedWabas.length > 0 && !authorizedWabas.includes(wabaId))) throw new SignupDiscoveryError("WABA_MISMATCH")

  const phones: string[] = []
  let next: string | null = `${root}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`
  for (let page = 0; next && page < 10; page++) {
    try {
      const response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15000) })
      const body: { data?: Array<{ id?: string }>; paging?: { next?: string } } = await response.json()
      if (!response.ok) throw new Error("Meta phone discovery failed")
      for (const phone of body.data ?? []) if (validId(phone.id)) phones.push(phone.id)
      const candidate = body.paging?.next
      next = candidate?.startsWith(`${root}/`) ? candidate : null
    } catch { throw new SignupDiscoveryError("META_DISCOVERY_FAILED") }
  }
  const phoneNumberId = input.phoneNumberId || (phones.length === 1 ? phones[0] : undefined)
  if (!phoneNumberId) throw new SignupDiscoveryError("PHONE_NUMBER_ID_MISSING")
  if (!validId(phoneNumberId) || !phones.includes(phoneNumberId)) throw new SignupDiscoveryError("PHONE_MISMATCH")

  return { wabaId, phoneNumberId, businessId: validId(input.businessId) ? input.businessId : undefined }
}
