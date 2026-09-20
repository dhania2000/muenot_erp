import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { eventOverview, retryDelivery, setSubscriptionEnabled, subscribe } from "@/lib/events/bus"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function GET() {
  const guard=await requireTenantAdmin()
  if(!guard.ok) return NextResponse.json({error:guard.reason},{status:guard.status})
  try{return NextResponse.json(await eventOverview(effectiveTenantId(guard.ctx)!))}
  catch{return NextResponse.json({error:"Unable to load business events"},{status:500})}
}
export async function POST(request:Request) {
  const guard=await requireTenantAdmin()
  if(!guard.ok) return NextResponse.json({error:guard.reason},{status:guard.status})
  const origin=request.headers.get("origin")
  if(origin && origin!==new URL(process.env.APP_URL||request.url).origin) return NextResponse.json({error:"Invalid origin"},{status:403})
  const tenant=effectiveTenantId(guard.ctx)!, actor=guard.session.userId
  try {
    const raw=await request.text()
    if(raw.length>8192) return NextResponse.json({error:"Request too large"},{status:413})
    const body=JSON.parse(raw)
    if(body.operation==="subscribe") return NextResponse.json({id:await subscribe(tenant,actor,body.subscription)},{status:201})
    if(!Number.isSafeInteger(body.id)||body.id<1) throw new Error("Valid ID required")
    if(body.operation==="toggle" && typeof body.enabled==="boolean") await setSubscriptionEnabled(tenant,actor,body.id,body.enabled)
    else if(body.operation==="retry" && Number.isSafeInteger(body.attempt) && body.attempt>0) await retryDelivery(tenant,actor,body.id,body.attempt)
    else throw new Error("Invalid event operation")
    return NextResponse.json({ok:true})
  } catch(error) {
    const message=error instanceof Error && !("code" in error) ? error.message:"Event operation failed"
    return NextResponse.json({error:message},{status:400})
  }
}
