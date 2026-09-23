export type FacebookLoginResponse = { authResponse?: { code?: string } | null; status?: string }
export type FacebookSdk = {
  init: (params: Record<string, unknown>) => void
  login: (callback: (response: FacebookLoginResponse) => void, options: Record<string, unknown>) => void
}
export type SignupConfig = { appId: string | null; configId: string | null; graphVersion: string; ready: boolean; missing?: string[]; state?: string }

export function requireSignupConfig(config: SignupConfig) {
  if (!config.ready || !config.appId || !config.configId) {
    throw new Error("Meta signup needs server settings: " + (config.missing?.join(", ") || "WHATSAPP_APP_ID, WHATSAPP_CONFIG_ID") + ". Ask your platform administrator to configure them and restart the app, then retry.")
  }
}

// Do not make this async or defer login: the browser's click activation is
// required by the SDK to open the real Facebook Login for Business popup.
export function launchFacebookSignup(sdk: FacebookSdk, config: SignupConfig): Promise<FacebookLoginResponse> {
  requireSignupConfig(config)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Facebook login did not finish. Allow popups for this site, close any old login window and retry.")), 180000)
    try {
      sdk.init({ appId: config.appId, autoLogAppEvents: false, xfbml: false, version: config.graphVersion })
      sdk.login(response => { clearTimeout(timer); resolve(response) }, {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      })
    } catch (error) { clearTimeout(timer); reject(error) }
  })
}

export function signupDetails(event: Pick<MessageEvent, "origin" | "data">) {
  // Android Custom Tabs can emit the Embedded Signup message from Meta's
  // mobile host. Keep an exact allowlist; never accept arbitrary subdomains.
  if (!["https://www.facebook.com", "https://web.facebook.com", "https://m.facebook.com"].includes(event.origin)) return null
  try {
    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
    if (data?.type !== "WA_EMBEDDED_SIGNUP" || !["FINISH", "FINISH_ONLY_WABA"].includes(data.event)) return null
    const { waba_id, phone_number_id, business_id } = data.data ?? {}
    const id = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? value : undefined
    const wabaId = id(waba_id)
    const phoneNumberId = id(phone_number_id)
    if (!wabaId && !phoneNumberId) return null
    return { wabaId, phoneNumberId, businessId: id(business_id) }
  } catch { return null }
}
