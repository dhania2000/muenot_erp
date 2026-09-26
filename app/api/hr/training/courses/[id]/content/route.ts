import { requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { addModule, addLesson, addQuestion, TrainingError } from "@/lib/training/store"
import { isLessonType } from "@/lib/training/model"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Ctx) {
  const session = await requireManager("update")
  if (!session) return forbidden()
  const { id } = await params
  return run(async () => {
    const courseId = parseId(id)
    const body = await request.json().catch(() => ({}))
    const kind = String(body?.kind ?? "")
    if (kind === "module") {
      if (!body.title) throw new TrainingError("title is required")
      return addModule(courseId, String(body.title), Number(body.sort_order) || 0)
    }
    if (kind === "lesson") {
      if (!body.title) throw new TrainingError("title is required")
      if (!isLessonType(body.lesson_type)) throw new TrainingError("Invalid lesson_type")
      if ((body.lesson_type === "video" || body.lesson_type === "document") && body.media_id == null) {
        throw new TrainingError("media_id is required for video/document lessons")
      }
      return addLesson(courseId, {
        title: String(body.title),
        lesson_type: body.lesson_type,
        media_id: body.media_id != null ? Number(body.media_id) : null,
        content: body.content != null ? String(body.content) : null,
        duration_seconds: Number(body.duration_seconds) || 0,
        module_id: body.module_id != null ? Number(body.module_id) : null,
        sort_order: Number(body.sort_order) || 0,
      })
    }
    if (kind === "question") {
      if (!Array.isArray(body.options)) throw new TrainingError("options must be an array")
      return addQuestion(courseId, {
        question: String(body.question ?? ""),
        options: body.options.map((o: unknown) => String(o)),
        correct_index: Number(body.correct_index),
        points: Number(body.points) || 1,
        sort_order: Number(body.sort_order) || 0,
      })
    }
    throw new TrainingError("Unknown content kind")
  })
}
