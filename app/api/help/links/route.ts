import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { isModuleEnabled } from "@/lib/settings/server"
import {
  resolveModuleKey,
  getHelpTopics,
  isKnownModuleKey,
  canSearchKnowledgeBase,
  HELP_TOPICS,
  GENERAL_HELP,
  type HelpAccess,
} from "@/lib/help-center"
import { NO_STORE, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

/**
 * Contextual help links for the caller's current location, filtered by their
 * permissions, role and the tenant's module toggles (settings are resolved for
 * the session tenant), so a hidden module contributes no links.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })

    const url = new URL(request.url)
    const requested = url.searchParams.get("module")
    if (requested != null && !isKnownModuleKey(requested)) {
      return NextResponse.json({ error: "Unknown module", code: "INVALID_MODULE" }, { status: 400, headers: NO_STORE })
    }
    const moduleKey = requested ?? resolveModuleKey(url.searchParams.get("path"))

    const slugs = new Set<string>()
    for (const t of [...(HELP_TOPICS[moduleKey] ?? []), ...GENERAL_HELP]) if (t.module) slugs.add(t.module)
    const enabled = new Map<string, boolean>()
    await Promise.all([...slugs].map(async (s) => enabled.set(s, await isModuleEnabled(s))))

    const checker = await getFeatureChecker(session.userId, session.role)
    const access: HelpAccess = {
      hasFeature: (slug) => checker(slug),
      isModuleEnabled: (slug) => enabled.get(slug) ?? true,
      isAdmin: session.role === "admin",
    }

    return NextResponse.json(
      { module: moduleKey, topics: getHelpTopics(moduleKey, access), canSearch: canSearchKnowledgeBase(access) },
      { headers: NO_STORE },
    )
  } catch (err) {
    return errorResponse(err, "Failed to load help links")
  }
}
