import { getProviderById } from "@/lib/sso-store"
import { createSaml } from "@/lib/sso-saml"
function origin(r: Request) { return `${r.headers.get("x-forwarded-proto") || "https"}://${r.headers.get("x-forwarded-host") || r.headers.get("host") || ""}` }
export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) { const p=await getProviderById(Number((await params).providerId)); if (!p || p.type!=="saml") return new Response("Not found",{status:404}); try{return new Response(createSaml(p,origin(request)).generateServiceProviderMetadata(null),{headers:{"Content-Type":"application/samlmetadata+xml"}})}catch{return new Response("Invalid SAML provider",{status:400})} }
