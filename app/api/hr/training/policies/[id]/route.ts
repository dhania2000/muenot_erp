import { requireLearner, requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { getPolicyDetail, publishPolicyVersion, TrainingError } from "@/lib/training/store"
import { resolveEmployee } from "@/lib/knowledge-base"
import { validatePolicy } from "@/lib/training/model"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id } = await params
  return run(async () => {
    const emp = await resolveEmployee(session)
    return getPolicyDetail(parseId(id), emp?.id ?? null)
  })
}

export async function PATCH(request: Request, { params }: Ctx) {
  const session = await requireManager("update")
  if (!session) return forbidden()
  const { id } = await params
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const parsed = validatePolicy(body)
    if (!parsed.ok) throw new TrainingError(parsed.error, 400)
    return publishPolicyVersion(parseId(id), parsed.value, session)
  })
}
