import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listSocialAccounts, toPublicAccount } from "@/lib/social-accounts"
import { SOCIAL_PLATFORMS } from "@/lib/social-platforms"
import { isPlatformConfigured, linkedinOrgEnabled } from "@/lib/social-oauth"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const rows = await listSocialAccounts()
  const accounts = rows.map(toPublicAccount)

  const configured: Record<string, boolean> = {}
  for (const p of SOCIAL_PLATFORMS) configured[p.id] = isPlatformConfigured(p.id)

  // Capabilities the client needs to gate optional flows. LinkedIn company-page
  // posting is only offered when the app holds Community Management access.
  const capabilities = { linkedinOrg: linkedinOrgEnabled() }

  return NextResponse.json({ accounts, configured, capabilities })
}
