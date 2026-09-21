import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { getProviderById } from "@/lib/sso-store"
import { createSaml } from "@/lib/sso-saml"
import { issueSsoState } from "@/lib/sso-state"
function origin(r: Request) { return `${r.headers.get("x-forwarded-proto") || "https"}://${r.headers.get("x-forwarded-host") || r.headers.get("host") || ""}` }
export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const provider = await getProviderById(Number((await params).providerId))
  if (!provider || provider.type !== "saml" || provider.status !== "enabled") return NextResponse.redirect(new URL("/login?sso_error=unavailable", origin(request)))
  try { const state=randomUUID(); await issueSsoState({providerId:provider.id,protocol:"saml",state,nonce:randomUUID(),redirectTo:"/dashboard"}); return NextResponse.redirect(await createSaml(provider,origin(request)).getAuthorizeUrlAsync(state, undefined, {})) }
  catch { return NextResponse.redirect(new URL("/login?sso_error=misconfigured", origin(request))) }
}
