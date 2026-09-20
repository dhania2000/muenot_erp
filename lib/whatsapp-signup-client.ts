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
  if (!["https://www.facebook.com", "https://web.facebook.com"].includes(event.origin)) return null
  try {
    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
    if (data?.type !== "WA_EMBEDDED_SIGNUP" || data.event !== "FINISH") return null
    const { waba_id, phone_number_id, business_id } = data.data ?? {}
    if (typeof waba_id !== "string" || !/^\d+$/.test(waba_id) || typeof phone_number_id !== "string" || !/^\d+$/.test(phone_number_id)) return null
    return { wabaId: waba_id, phoneNumberId: phone_number_id, businessId: typeof business_id === "string" ? business_id : undefined }
  } catch { return null }
}
