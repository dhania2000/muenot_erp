import { mobileJson } from "@/lib/mobile-api"
import { getSignupReadiness } from "@/lib/whatsapp-signup"
export const runtime = "nodejs"
// App ID and Meta configuration ID are public SDK identifiers, not credentials.
export async function GET() { return mobileJson(getSignupReadiness()) }
