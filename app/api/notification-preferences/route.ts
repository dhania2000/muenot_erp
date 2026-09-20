import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantRole } from "@/lib/platform-guard"
import { ownPreferences, savePreference } from "@/lib/notification-engine/service"
export const dynamic="force-dynamic"
export async function GET(){
  const g=await requireTenantRole("employee")
  if(!g.ok)return NextResponse.json({error:g.reason},{status:g.status})
  try{return NextResponse.json(await ownPreferences(effectiveTenantId(g.ctx)!,g.session.userId))}
  catch{return NextResponse.json({error:"Unable to load preferences"},{status:500})}
}
export async function POST(request:Request){
  const g=await requireTenantRole("employee")
  if(!g.ok)return NextResponse.json({error:g.reason},{status:g.status})
  const origin=request.headers.get("origin")
  if(origin&&origin!==new URL(process.env.APP_URL||request.url).origin)return NextResponse.json({error:"Invalid origin"},{status:403})
  try{
    const raw=await request.text();if(raw.length>2048)throw new Error("Request too large")
    const b=JSON.parse(raw)
    if(b.destination!=null&&typeof b.destination!=="string")throw new Error("Invalid destination")
    await savePreference(effectiveTenantId(g.ctx)!,g.session.userId,b.channel,b.enabled,b.destination||null)
    return NextResponse.json({ok:true})
  }catch(e){return NextResponse.json({error:e instanceof Error&&!("code"in e)?e.message:"Preference update failed"},{status:400})}
}
