import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { resolveModuleKey, getHelpTopics } from "@/lib/help-center"
import { NO_STORE, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

/**
 * Contextual help links for the caller's current location, filtered by their
 * permissions so a hidden / inaccessible module contributes no links.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })

    const url = new URL(request.url)
    const moduleKey = url.searchParams.get("module") || resolveModuleKey(url.searchParams.get("path"))

    const checker = await getFeatureChecker(session.userId, session.role)
    const topics = getHelpTopics(moduleKey, (slug) => checker(slug))

    return NextResponse.json({ module: moduleKey, topics }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to load help links")
  }
}
