import "server-only"
import { getSettings } from "@/lib/settings/server"
import { resolveCareersContent, type CareersContent } from "@/lib/careers-content"

/** Effective careers-site content for server rendering (public pages). */
export async function getCareersContent(): Promise<CareersContent> {
  const settings = await getSettings()
  return resolveCareersContent(settings as Record<string, string>)
}
