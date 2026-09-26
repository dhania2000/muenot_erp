import { requireLearner, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { markLessonComplete, requireEmployee } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string; lessonId: string }> }

export async function POST(_req: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id, lessonId } = await params
  return run(async () => {
    const emp = await requireEmployee(session)
    return markLessonComplete(parseId(id), parseId(lessonId), emp.id)
  })
}
