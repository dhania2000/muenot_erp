import { requireManager, run, forbidden } from "@/lib/training/route-helpers"
import { registerMedia, TrainingError } from "@/lib/training/store"
import { isMediaAccess } from "@/lib/training/model"

export async function POST(request: Request) {
  const session = await requireManager("add")
  if (!session) return forbidden()
  return run(async () => {
    const body = await request.json().catch(() => ({}))
    if (!body?.storage_key) throw new TrainingError("storage_key is required")
    return registerMedia(
      {
        storage_key: String(body.storage_key),
        file_name: body.file_name != null ? String(body.file_name) : null,
        mime: body.mime != null ? String(body.mime) : null,
        size: Number(body.size) || 0,
        access: isMediaAccess(body.access) ? body.access : "assigned",
        expires_at: body.expires_at != null ? String(body.expires_at) : null,
      },
      session,
    )
  })
}
