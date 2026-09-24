import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantRole } from "@/lib/platform-guard"
import { ownModulePreferences, ownPreferences, saveModulePreference, savePreference } from "@/lib/notification-engine/service"
export const dynamic="force-dynamic"
export async function GET(){
  const g=await requireTenantRole("employee")
  if(!g.ok)return NextResponse.json({error:g.reason},{status:g.status})
  try{
    const tenant=effectiveTenantId(g.ctx)!
    const [channels,modules]=await Promise.all([ownPreferences(tenant,g.session.userId),ownModulePreferences(tenant,g.session.userId)])
    return NextResponse.json({channels,modules})
  }
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
    const tenant=effectiveTenantId(g.ctx)!
    if(b.type==="module"){
      if(typeof b.moduleKey!=="string"||typeof b.enabled!=="boolean")throw new Error("Invalid module preference")
      await saveModulePreference(tenant,g.session.userId,b.moduleKey,b.enabled)
      return NextResponse.json({ok:true})
    }
    if(b.destination!=null&&typeof b.destination!=="string")throw new Error("Invalid destination")
    if(b.frequency!==undefined||b.minPriority!==undefined){
      await savePreference(tenant,g.session.userId,b.channel,b.enabled,b.destination||null,{minPriority:b.minPriority,frequency:b.frequency})
    }else{
      await savePreference(tenant,g.session.userId,b.channel,b.enabled,b.destination||null)
    }
    return NextResponse.json({ok:true})
  }catch(e){return NextResponse.json({error:e instanceof Error&&!("code"in e)?e.message:"Preference update failed"},{status:400})}
}
