import { NextResponse } from "next/server"
import { listEnabledProvidersForLogin } from "@/lib/sso-store"

/** Public, unauthenticated — the login page needs this to render "Continue with ..." buttons. */
export async function GET() {
  const providers = await listEnabledProvidersForLogin()
  return NextResponse.json({ providers })
}
