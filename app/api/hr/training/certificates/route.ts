import { requireLearner, run, forbidden } from "@/lib/training/route-helpers"
import { listMyCertificates, requireEmployee } from "@/lib/training/store"

export async function GET() {
  const session = await requireLearner()
  if (!session) return forbidden("Unauthorized")
  return run(async () => {
    const emp = await requireEmployee(session)
    return listMyCertificates(emp.id)
  })
}
