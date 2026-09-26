import { requireManager, run, forbidden } from "@/lib/training/route-helpers"
import { listMedia, registerMedia, uploadTrainingMedia, TrainingError } from "@/lib/training/store"
import { isMediaAccess } from "@/lib/training/model"

export async function GET() {
  const session = await requireManager("view")
  if (!session) return forbidden()
  return run(() => listMedia())
}

/**
 * Upload (multipart `file`) or register an already-stored tenant object (JSON
 * `storage_key`). Both paths go through central private storage.
 */
export async function POST(request: Request) {
  const session = await requireManager("add")
  if (!session) return forbidden()
  return run(async () => {
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData()
      const file = form.get("file")
      if (!(file instanceof File)) throw new TrainingError("file is required")
      const access = form.get("access")
      const expires = form.get("expires_at")
      return uploadTrainingMedia(
        file,
        {
          access: isMediaAccess(access) ? access : "assigned",
          expires_at: typeof expires === "string" && expires ? expires : null,
        },
        session,
      )
    }
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
