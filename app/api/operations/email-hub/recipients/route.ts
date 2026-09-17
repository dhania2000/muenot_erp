import { hubRecipientsHandler } from "@/lib/email-hub-api"

export const GET = hubRecipientsHandler({ module: "operations", feature: "operations.emails" })
