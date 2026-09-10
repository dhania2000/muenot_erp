import { MessageSquare } from "lucide-react"
import { MarketingChannelClient, type ChannelConfig } from "@/components/marketing/marketing-channel-client"

const config: ChannelConfig = {
  key: "sms",
  title: "SMS Campaigns",
  description: "Send timely text messages and track delivery and click-through performance.",
  icon: MessageSquare,
  engagementLabel: "Click Rate",
  createLabel: "New SMS Blast",
  reachLabel: "Recipients",
  seed: [
    { id: "SMS-101", name: "Flash Sale — 24h Only", status: "Completed", audience: 12400, sent: 12400, engagement: "12.5%" },
    { id: "SMS-102", name: "Appointment Reminders", status: "Active", audience: 3200, sent: 2800, engagement: "18.9%" },
    { id: "SMS-103", name: "New Store Opening", status: "Scheduled", audience: 8600, sent: 0, engagement: "—" },
    { id: "SMS-104", name: "Loyalty Points Expiry", status: "Draft", audience: 5400, sent: 0, engagement: "—" },
  ],
}

export default function SmsCampaignsPage() {
  return <MarketingChannelClient config={config} />
}
