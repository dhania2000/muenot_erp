import { NextResponse } from "next/server"
import { runEventWorker } from "@/lib/events/bus"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export const maxDuration=300
export async function GET(request:Request) {
  if(!process.env.CRON_SECRET || request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({error:"Unauthorized"},{status:401})
  try{return NextResponse.json(await runEventWorker())}
  catch{return NextResponse.json({error:"Event worker failed"},{status:500})}
}
