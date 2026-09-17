import { hubAutomationsGetHandler, hubAutomationsPatchHandler } from "@/lib/email-hub-api"

const cfg = { module: "recruit" as const, feature: "recruitment.view_applications" }

export const GET = hubAutomationsGetHandler(cfg)
export const PATCH = hubAutomationsPatchHandler(cfg)
