import { hubCreateHandler, hubListHandler } from "@/lib/email-hub-api"

const cfg = { module: "operations" as const, feature: "operations.emails" }

export const GET = hubListHandler(cfg)
export const POST = hubCreateHandler(cfg)
