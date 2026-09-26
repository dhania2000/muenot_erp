import { requireLearner, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { getAssignmentForLearner, requireEmployee } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id } = await params
  return run(async () => {
    const emp = await requireEmployee(session)
    return getAssignmentForLearner(parseId(id), emp.id)
  })
}
