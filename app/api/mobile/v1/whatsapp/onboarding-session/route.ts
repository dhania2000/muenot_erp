import { isMobileResponse, mobileJson, withMobileAuth } from "@/lib/mobile-api"
import { createMobileOnboarding, MobileOnboardingError } from "@/lib/mobile-whatsapp-onboarding"

export const runtime = "nodejs"
export async function POST(request: Request) {
  const result = await withMobileAuth(request, async principal => {
    try { return mobileJson(await createMobileOnboarding(principal), { status: 201 }) }
    catch (error) { return mobileJson({ error: error instanceof MobileOnboardingError ? error.message : "Could not start WhatsApp onboarding." }, { status: error instanceof MobileOnboardingError ? error.status : 500 }) }
  }, "whatsapp")
  return isMobileResponse(result) ? result : result
}
