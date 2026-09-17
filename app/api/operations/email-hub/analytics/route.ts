import { hubAnalyticsHandler } from "@/lib/email-hub-api"

export const GET = hubAnalyticsHandler({ module: "operations", feature: "operations.emails" })
