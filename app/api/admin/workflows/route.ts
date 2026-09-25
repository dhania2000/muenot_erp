import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { WorkflowError, cancelWorkflow, decideWorkflow, previewWorkflow, publishWorkflow, retryWorkflowRun, rollbackWorkflow, saveWorkflow, setWorkflowEnabled, simulateWorkflowRun, startWorkflow, workflowOverview } from "@/lib/workflows/engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
const optionalVersion = (v: unknown) => v == null ? undefined : id(v) ? Number(v) : NaN
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
  // Tenant is always taken from the authenticated session, never from the body.
  const tenant = effectiveTenantId(guard.ctx)!, actor = guard.session.userId
  try {
    const raw = await request.text()
    if (raw.length > 32768) return NextResponse.json({error:"Workflow request too large"},{status:413})
    const body = JSON.parse(raw)
    const expected = optionalVersion(body.expectedVersion)
    if (Number.isNaN(expected)) return NextResponse.json({error:"Invalid expected version"},{status:400})
    if (body.operation === "create") return NextResponse.json({id:await saveWorkflow(tenant,actor,body.definition)},{status:201})
    if (body.operation === "update" && id(body.id)) return NextResponse.json({id:await saveWorkflow(tenant,actor,body.definition,Number(body.id),expected)})
    if (body.operation === "toggle" && id(body.id) && typeof body.enabled === "boolean") {
      await setWorkflowEnabled(tenant,actor,Number(body.id),body.enabled)
      return NextResponse.json({ok:true})
    }
    if (body.operation === "publish" && id(body.id)) return NextResponse.json(await publishWorkflow(tenant,actor,Number(body.id),expected))
    if (body.operation === "rollback" && id(body.id) && id(body.version)) return NextResponse.json(await rollbackWorkflow(tenant,actor,Number(body.id),Number(body.version),body.publish === true))
    if (body.operation === "simulate" && (body.recordId == null || id(body.recordId))) return NextResponse.json(await simulateWorkflowRun(tenant,actor,body.definition,body.recordId == null ? undefined : Number(body.recordId)))
    if (body.operation === "preview" && id(body.recordId)) return NextResponse.json(await previewWorkflow(tenant,actor,body.definition,Number(body.recordId)))
    if (body.operation === "start") return NextResponse.json({id:await startWorkflow(tenant,actor,Number(body.workflowId),Number(body.recordId),body.requestKey,body.at)})
    if (body.operation === "retry" && id(body.runId)) {
      await retryWorkflowRun(tenant,actor,body.runId)
      return NextResponse.json({ok:true})
    }
    if (body.operation === "cancel" && id(body.runId)) {
      await cancelWorkflow(tenant,actor,body.runId)
      return NextResponse.json({ok:true})
    }
    if (body.operation === "decide" && id(body.runId) && typeof body.approve === "boolean") {
      await decideWorkflow(tenant,actor,body.runId,body.approve)
      return NextResponse.json({ok:true})
    }
    return NextResponse.json({error:"Invalid workflow operation"},{status:400})
  } catch (error) {
    // Database diagnostics can include SQL or tenant data. Never serialize them.
    const dbError = error && typeof error === "object" && "code" in error
    const status = error instanceof WorkflowError ? error.status : 400
    return NextResponse.json({error:dbError ? "Workflow unavailable. Check database migrations." : error instanceof Error ? error.message : "Invalid request"},{status})
  }
}
