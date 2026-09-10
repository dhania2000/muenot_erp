import { MessageCircle } from "lucide-react"
import { MarketingChannelClient, type ChannelConfig } from "@/components/marketing/marketing-channel-client"

const config: ChannelConfig = {
  key: "wa",
  title: "WhatsApp Campaigns",
  description: "Broadcast template messages and nurture conversations on WhatsApp Business.",
  icon: MessageCircle,
  engagementLabel: "Reply Rate",
  createLabel: "New Broadcast",
  reachLabel: "Recipients",
  seed: [
    { id: "WA-101", name: "Order Confirmation Flow", status: "Active", audience: 9200, sent: 8900, engagement: "24.6%" },
    { id: "WA-102", name: "Festive Offer Broadcast", status: "Sending", audience: 15600, sent: 7100, engagement: "19.2%" },
    { id: "WA-103", name: "Feedback Request", status: "Scheduled", audience: 4300, sent: 0, engagement: "—" },
    { id: "WA-104", name: "Restock Alert", status: "Draft", audience: 2700, sent: 0, engagement: "—" },
  ],
}

export default function WhatsAppCampaignsPage() {
  return <MarketingChannelClient config={config} />
}
