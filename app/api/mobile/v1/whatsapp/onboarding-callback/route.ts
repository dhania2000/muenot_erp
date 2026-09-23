import { mobileJson } from "@/lib/mobile-api"
import { finishMobileSignup, MobileOnboardingError } from "@/lib/mobile-whatsapp-onboarding"
export const runtime = "nodejs"
export async function POST(request: Request) {
  const raw = await request.text().catch(() => "")
  if (raw.length > 16384) return mobileJson({ error: "Invalid request." }, { status: 413 })
  let body: Record<string, unknown> = {}
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown> } catch { /* invalid fields below */ }
  try {
    return mobileJson(await finishMobileSignup({ launchToken: String(body.launchToken ?? ""), state: String(body.state ?? ""),
      code: String(body.code ?? ""), wabaId: String(body.wabaId ?? ""), phoneNumberId: String(body.phoneNumberId ?? ""),
      businessId: typeof body.businessId === "string" ? body.businessId : undefined }))
  } catch (error) { return mobileJson({ error: error instanceof MobileOnboardingError ? error.message : "Could not complete WhatsApp connection." }, { status: error instanceof MobileOnboardingError ? error.status : 500 }) }
}
