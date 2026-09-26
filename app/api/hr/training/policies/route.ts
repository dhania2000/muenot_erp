import { requireLearner, requireManager, run, forbidden } from "@/lib/training/route-helpers"
import { listPolicies, createPolicy, TrainingError } from "@/lib/training/store"
import { resolveEmployee } from "@/lib/knowledge-base"
import { validatePolicy } from "@/lib/training/model"

export async function GET() {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  return run(async () => {
    const emp = await resolveEmployee(session)
    return listPolicies(emp?.id ?? null)
  })
}

export async function POST(request: Request) {
  const session = await requireManager("add")
  if (!session) return forbidden()
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const parsed = validatePolicy(body)
    if (!parsed.ok) throw new TrainingError(parsed.error, 400)
    return createPolicy(parsed.value, session)
  })
}
