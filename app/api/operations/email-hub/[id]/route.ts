import { hubItemGetHandler, hubItemPatchHandler } from "@/lib/email-hub-api"

const cfg = { module: "operations" as const, feature: "operations.emails" }

export const GET = hubItemGetHandler(cfg)
export const PATCH = hubItemPatchHandler(cfg)
