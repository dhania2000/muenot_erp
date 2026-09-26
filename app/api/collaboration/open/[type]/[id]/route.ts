import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { resolveDeepLink } from "@/lib/collaboration/service"

/** Notification deep link: re-checks access at click time, then redirects. */
export async function GET(request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const url = new URL(request.url)
  const auth = await requireTenant()
  if (!auth) return NextResponse.redirect(new URL("/login", url.origin), 303)
  const { type, id } = await params
  try {
    const target = await resolveDeepLink(auth.session, auth.tenantId, type, id, url.searchParams.get("comment"))
    return NextResponse.redirect(new URL(target.url, url.origin), 303)
  } catch (err) {
    console.error("[collaboration] deep link failed", err)
    return NextResponse.redirect(new URL("/notifications?denied=1", url.origin), 303)
  }
}
