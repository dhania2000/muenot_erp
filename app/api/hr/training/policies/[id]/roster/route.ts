import { requireManager, run, forbidden, parseId } from "@/lib/training/route-helpers"
import { listPolicyAcknowledgments, listPolicyRoster } from "@/lib/training/store"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const session = await requireManager("view")
  if (!session) return forbidden()
  const { id } = await params
  return run(async () => {
    const policyId = parseId(id)
    const [roster, evidence] = await Promise.all([listPolicyRoster(policyId), listPolicyAcknowledgments(policyId)])
    return { ...roster, evidence }
  })
}
