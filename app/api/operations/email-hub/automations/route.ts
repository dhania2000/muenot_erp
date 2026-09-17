import { hubAutomationsGetHandler, hubAutomationsPatchHandler } from "@/lib/email-hub-api"

const cfg = { module: "operations" as const, feature: "operations.emails" }

export const GET = hubAutomationsGetHandler(cfg)
export const PATCH = hubAutomationsPatchHandler(cfg)
