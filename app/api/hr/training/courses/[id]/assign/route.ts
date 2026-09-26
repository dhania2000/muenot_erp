import { requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { assignCourse } from "@/lib/training/store"
import { parseStringArray } from "@/lib/training/model"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Ctx) {
  const session = await requireManager("update")
  if (!session) return forbidden()
  const { id } = await params
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const employeeIds = Array.isArray(body?.employeeIds)
      ? body.employeeIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n))
      : []
    return assignCourse(
      parseId(id),
      {
        roles: parseStringArray(body?.roles),
        employeeIds,
        reassign: Boolean(body?.reassign),
        idempotencyKey: request.headers.get("idempotency-key") ?? body?.idempotencyKey ?? null,
      },
      session,
    )
  })
}
