import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { notificationOverview, retryNotification, saveTemplate, sendTemplate } from "@/lib/notification-engine/service"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function GET(){
  const g=await requireTenantAdmin()
  if(!g.ok)return NextResponse.json({error:g.reason},{status:g.status})
  try{return NextResponse.json(await notificationOverview(effectiveTenantId(g.ctx)!))}
  catch{return NextResponse.json({error:"Unable to load notification engine"},{status:500})}
}
export async function POST(request:Request){
  const g=await requireTenantAdmin()
  if(!g.ok)return NextResponse.json({error:g.reason},{status:g.status})
  const origin=request.headers.get("origin")
  if(origin&&origin!==new URL(process.env.APP_URL||request.url).origin)return NextResponse.json({error:"Invalid origin"},{status:403})
  try{
    const raw=await request.text()
    if(raw.length>32768)return NextResponse.json({error:"Request too large"},{status:413})
    const b=JSON.parse(raw),tenant=effectiveTenantId(g.ctx)!,actor=g.session.userId
    if(b.operation==="template")return NextResponse.json({id:await saveTemplate(tenant,actor,b.name,b.title,b.body)},{status:201})
    if(b.operation==="send")return NextResponse.json({id:await sendTemplate(tenant,b)})
    if(b.operation==="retry"&&Number.isSafeInteger(b.id)&&b.id>0&&Number.isSafeInteger(b.attempt)&&b.attempt>=0){await retryNotification(tenant,actor,b.id,b.attempt);return NextResponse.json({ok:true})}
    throw new Error("Invalid operation")
  }catch(e){return NextResponse.json({error:e instanceof Error&&!("code"in e)?e.message:"Notification request failed"},{status:400})}
}
