import { requireManager, run, forbidden } from "@/lib/training/route-helpers"
import { listCourses, createCourse } from "@/lib/training/store"
import { validateCourse } from "@/lib/training/model"
import { TrainingError } from "@/lib/training/store"

export async function GET() {
  const session = await requireManager("view")
  if (!session) return forbidden()
  return run(() => listCourses())
}

export async function POST(request: Request) {
  const session = await requireManager("add")
  if (!session) return forbidden()
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const parsed = validateCourse(body)
    if (!parsed.ok) throw new TrainingError(parsed.error, 400)
    return createCourse(parsed.value, session)
  })
}
