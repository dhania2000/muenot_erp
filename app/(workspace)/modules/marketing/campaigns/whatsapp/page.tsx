import { redirect } from "next/navigation"

// WhatsApp is now its own top-level module. Keep this old campaigns URL working
// by redirecting anyone who lands here to the new location.
export default function WhatsAppCampaignsRedirect() {
  redirect("/modules/whatsapp")
}
