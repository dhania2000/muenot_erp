import { requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { getCourseDetail, updateCourse, deleteCourse, TrainingError } from "@/lib/training/store"
import { validateCourse } from "@/lib/training/model"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireManager("view")
  if (!session) return forbidden()
  const { id } = await params
  return run(() => getCourseDetail(parseId(id), { includeAnswers: true }))
}

export async function PATCH(request: Request, { params }: Ctx) {
  const session = await requireManager("update")
  if (!session) return forbidden()
  const { id } = await params
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const parsed = validateCourse(body)
    if (!parsed.ok) throw new TrainingError(parsed.error, 400)
    return updateCourse(parseId(id), parsed.value, session)
  })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const session = await requireManager("delete")
  if (!session) return forbidden()
  const { id } = await params
  return run(() => deleteCourse(parseId(id)))
}
