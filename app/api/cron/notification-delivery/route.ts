import { NextResponse } from "next/server"
import { runNotificationWorker } from "@/lib/notification-engine/service"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export const maxDuration=300
export async function GET(request:Request){
  if(!process.env.CRON_SECRET||request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401})
  try{return NextResponse.json(await runNotificationWorker())}catch{return NextResponse.json({error:"Notification worker failed"},{status:500})}
}
