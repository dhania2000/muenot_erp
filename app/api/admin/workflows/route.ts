import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { cancelWorkflow, decideWorkflow, saveWorkflow, startWorkflow, workflowOverview } from "@/lib/workflows/engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error:guard.reason },{status:guard.status})
  try { return NextResponse.json(await workflowOverview(effectiveTenantId(guard.ctx)!,guard.session.userId)) }
  catch { return NextResponse.json({error:"Unable to load workflows"},{status:500}) }
}
export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error:guard.reason },{status:guard.status})
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(process.env.APP_URL || request.url).origin) return NextResponse.json({error:"Invalid origin"},{status:403})
  const tenant = effectiveTenantId(guard.ctx)!, actor = guard.session.userId
  try {
    const raw = await request.text()
    if (raw.length > 32768) return NextResponse.json({error:"Workflow request too large"},{status:413})
    const body = JSON.parse(raw)
    if (body.operation === "create") return NextResponse.json({id:await saveWorkflow(tenant,actor,body.definition)},{status:201})
    if (body.operation === "start") return NextResponse.json({id:await startWorkflow(tenant,actor,Number(body.workflowId),Number(body.recordId),body.requestKey,body.at)})
    if (body.operation === "cancel" && Number.isSafeInteger(body.runId) && body.runId > 0) {
      await cancelWorkflow(tenant,actor,body.runId)
      return NextResponse.json({ok:true})
    }
    if (body.operation === "decide" && Number.isSafeInteger(body.runId) && body.runId > 0 && typeof body.approve === "boolean") {
      await decideWorkflow(tenant,actor,body.runId,body.approve)
      return NextResponse.json({ok:true})
    }
    return NextResponse.json({error:"Invalid workflow operation"},{status:400})
  } catch (error) {
    // Database diagnostics can include SQL or tenant data. Never serialize them.
    const dbError = error && typeof error === "object" && "code" in error
    return NextResponse.json({error:dbError ? "Workflow unavailable. Check database migrations." : error instanceof Error ? error.message : "Invalid request"},{status:400})
  }
}
