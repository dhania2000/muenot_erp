import { requireLearner, run, forbidden, parseId, isManagerSession } from "@/lib/training/route-helpers"
import { getMediaAccessUrl } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  const { id } = await params
  return run(async () => {
    const isManager = await isManagerSession()
    return getMediaAccessUrl(parseId(id), session, isManager)
  })
}
