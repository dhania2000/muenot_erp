import { hubRecipientsHandler } from "@/lib/email-hub-api"

export const GET = hubRecipientsHandler({ module: "recruit", feature: "recruitment.view_applications" })
