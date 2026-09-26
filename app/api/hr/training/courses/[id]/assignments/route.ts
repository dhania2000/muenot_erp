import { requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { listCourseAssignments } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireManager("view")
  if (!session) return forbidden()
  const { id } = await params
  return run(() => listCourseAssignments(parseId(id)))
}
