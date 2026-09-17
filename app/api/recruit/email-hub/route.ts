import { hubCreateHandler, hubListHandler } from "@/lib/email-hub-api"

const cfg = { module: "recruit" as const, feature: "recruitment.view_applications" }

export const GET = hubListHandler(cfg)
export const POST = hubCreateHandler(cfg)
