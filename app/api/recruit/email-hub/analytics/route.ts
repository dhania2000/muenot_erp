import { hubAnalyticsHandler } from "@/lib/email-hub-api"

export const GET = hubAnalyticsHandler({ module: "recruit", feature: "recruitment.view_applications" })
