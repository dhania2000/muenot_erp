import { requireLearner, run, forbidden, parseId, clientIp } from "@/lib/training/route-helpers"
import { acknowledgePolicy, requireEmployee } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id } = await params
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    const employee = await requireEmployee(session)
    return acknowledgePolicy(
      parseId(id),
      {
        evidence: { ip: clientIp(request), userAgent: request.headers.get("user-agent") },
        idempotencyKey: request.headers.get("idempotency-key") ?? body?.idempotencyKey ?? null,
        readVersion: body?.version,
      },
      session,
      employee,
    )
  })
}
