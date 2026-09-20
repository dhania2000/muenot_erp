import { NextResponse } from "next/server"
import { runWorkflowWorker } from "@/lib/workflows/engine"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({error:"Unauthorized"},{status:401})
  try { return NextResponse.json(await runWorkflowWorker()) }
  catch { return NextResponse.json({error:"Workflow worker failed"},{status:500}) }
}
