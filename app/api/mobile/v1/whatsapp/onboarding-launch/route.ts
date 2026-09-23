import { mobileJson } from "@/lib/mobile-api"
import { launchMobileSignup, MobileOnboardingError } from "@/lib/mobile-whatsapp-onboarding"
export const runtime = "nodejs"
export async function POST(request: Request) {
  const raw = await request.text().catch(() => "")
  if (raw.length > 2048) return mobileJson({ error: "Invalid request." }, { status: 413 })
  let body: { launchToken?: unknown } = {}
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as typeof body } catch { /* invalid token below */ }
  try { return mobileJson(await launchMobileSignup(typeof body.launchToken === "string" ? body.launchToken : "")) }
  catch (error) { return mobileJson({ error: error instanceof MobileOnboardingError ? error.message : "Could not launch Meta signup." }, { status: error instanceof MobileOnboardingError ? error.status : 500 }) }
}
