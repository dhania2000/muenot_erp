import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { uploadFile } from "@/lib/storage"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { addAttachment } from "@/lib/operations-meeting-detail"

/**
 * File upload for meeting attachments (SPEC 112). Uses the same storage facade
 * as the rest of the app so files land in the tenant's connected storage under
 * a tenant-scoped key, then persists the returned reference onto the meeting.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })

  const up = await uploadFile(`operations-meetings/${id}/${crypto.randomUUID()}-${file.name}`, file, {
    metadata: {
      module: "operations",
      entityType: "meeting",
      entityId: String(id),
      ownerId: session.userId,
      classification: "internal",
    },
  })
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })

  const meeting = await addAttachment(
    id,
    {
      file_url: up.result.url,
      file_name: file.name,
      content_type: file.type || null,
      size_bytes: file.size || null,
    },
    { id: session.userId ?? null, name: session.name ?? null },
  )
  return NextResponse.json({ meeting, url: up.result.url })
}
