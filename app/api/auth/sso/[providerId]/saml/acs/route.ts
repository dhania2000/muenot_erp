import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { createSessionToken, setSessionCookie } from "@/lib/auth"
import { createSession, newSessionId } from "@/lib/session-store"
import { getIdentity, getProviderById, linkIdentity, recordLogin, recordLoginEvent } from "@/lib/sso-store"
import { createSaml, mappedSamlClaims } from "@/lib/sso-saml"
import { consumeSsoState } from "@/lib/sso-state"
import { sameTenant } from "@/lib/sso-provider-catalog"

function origin(r: Request) { return `${r.headers.get("x-forwarded-proto") || "https"}://${r.headers.get("x-forwarded-host") || r.headers.get("host") || ""}` }
function fail(r: Request, code: string) { return NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(code)}`, origin(r))) }

/** Signed SAML POST ACS. node-saml enforces signature, issuer, audience, time and InResponseTo. */
export async function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const provider = await getProviderById(Number((await params).providerId)); const state = await consumeSsoState()
  if (!provider || provider.type !== "saml" || provider.status !== "enabled" || !state || state.protocol !== "saml") return fail(request,"unavailable")
  try {
    const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>
    if (form.RelayState !== state.state || typeof form.SAMLResponse !== "string") return fail(request,"state_mismatch")
    const result = await createSaml(provider,origin(request)).validatePostResponseAsync({SAMLResponse:form.SAMLResponse,RelayState:form.RelayState})
    if (!result.profile || result.loggedOut) return fail(request,"denied")
    const claims = mappedSamlClaims(provider,result.profile); if (!claims.email) return fail(request,"no_email")
    if (provider.domains) { const allowed=provider.domains.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean); if(allowed.length&&!allowed.includes(claims.email.split("@")[1])) return fail(request,"domain_not_allowed") }
    const identity=await getIdentity(provider.id,claims.subject)
    type User={id:number;name:string;email:string;role:"admin"|"employee";status:string;tenant_id:number|null}
    let user:User|undefined
    if(identity?.deprovisioned_at) return fail(request,"account_inactive")
    if(identity){ user=(await query<User[]>("SELECT id,name,email,role,status,tenant_id FROM users WHERE id=? LIMIT 1",[identity.user_id]))[0]; if(!user||!sameTenant(provider.tenant_id,user.tenant_id)) return fail(request,"account_inactive") }
    else user=(await query<User[]>("SELECT id,name,email,role,status,tenant_id FROM users WHERE email=? AND tenant_id <=> ? LIMIT 1",[claims.email,provider.tenant_id]))[0]
    if(!user){ if(!provider.auto_provision) return fail(request,"no_account"); const result=await query<any>("INSERT INTO users (tenant_id,name,email,password_hash,role,status,must_change_password) VALUES (?,?,?,NULL,?,'active',0)",[provider.tenant_id,claims.name,claims.email,provider.default_role]); user={id:result.insertId,name:claims.name,email:claims.email,role:provider.default_role,status:"active",tenant_id:provider.tenant_id} }
    if(user.status!=="active") return fail(request,"account_inactive")
    await linkIdentity({providerId:provider.id,tenantId:provider.tenant_id,userId:user.id,subject:claims.subject,email:claims.email})
    const sid=newSessionId(); const token=await createSessionToken({userId:user.id,email:user.email,name:user.name,role:user.role,tenantId:user.tenant_id??provider.tenant_id??undefined,sid})
    await createSession({sessionId:sid,userId:user.id,tenantId:user.tenant_id??provider.tenant_id??null,ipAddress:request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()??null,userAgent:request.headers.get("user-agent"),loginMethod:"sso",expiresAt:new Date(Date.now()+7*86400000),concurrentLimit:5}); await setSessionCookie(token); await recordLogin(provider.id); await recordLoginEvent({providerId:provider.id,tenantId:provider.tenant_id,userId:user.id,email:claims.email,status:"success"})
    return NextResponse.redirect(new URL(user.role==="admin"?"/admin":"/dashboard",origin(request)))
  } catch(error) { await recordLoginEvent({providerId:provider.id,tenantId:provider.tenant_id,status:"error",message:error instanceof Error?error.message:"SAML validation failed"}); return fail(request,"exchange_failed") }
}
