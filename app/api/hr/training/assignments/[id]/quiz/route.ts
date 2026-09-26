import { requireLearner, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { submitQuiz, requireEmployee, TrainingError } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id } = await params
  return run(async () => {
    const emp = await requireEmployee(session)
    const body = await request.json().catch(() => ({}))
    if (!body || typeof body.answers !== "object" || body.answers == null) {
      throw new TrainingError("answers object is required")
    }
    const answers: Record<string, number> = {}
    for (const [k, v] of Object.entries(body.answers)) answers[k] = Number(v)
    return submitQuiz(parseId(id), { answers }, emp.id)
  })
}
