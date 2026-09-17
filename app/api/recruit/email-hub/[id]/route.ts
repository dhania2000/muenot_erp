import { hubItemGetHandler, hubItemPatchHandler } from "@/lib/email-hub-api"

const cfg = { module: "recruit" as const, feature: "recruitment.view_applications" }

export const GET = hubItemGetHandler(cfg)
export const PATCH = hubItemPatchHandler(cfg)
