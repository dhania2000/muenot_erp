import { MousePointerClick } from "lucide-react"
import { MarketingChannelClient, type ChannelConfig } from "@/components/marketing/marketing-channel-client"

const config: ChannelConfig = {
  key: "pop",
  title: "Engagement Pop-Ups",
  description: "Trigger on-site pop-ups and slide-ins to capture leads and drive conversions.",
  icon: MousePointerClick,
  engagementLabel: "Conversion Rate",
  createLabel: "New Pop-Up",
  reachLabel: "Impressions",
  seed: [
    { id: "POP-101", name: "Newsletter Signup — Exit Intent", status: "Active", audience: 48000, sent: 48000, engagement: "3.4%" },
    { id: "POP-102", name: "10% First Order Welcome", status: "Active", audience: 36000, sent: 36000, engagement: "5.1%" },
    { id: "POP-103", name: "Spin-to-Win Wheel", status: "Scheduled", audience: 0, sent: 0, engagement: "—" },
    { id: "POP-104", name: "Free Shipping Bar", status: "Completed", audience: 62000, sent: 62000, engagement: "2.2%" },
    { id: "POP-105", name: "Product Recommendation Slide-in", status: "Draft", audience: 0, sent: 0, engagement: "—" },
  ],
}

export default function EngagementPopupsPage() {
  return <MarketingChannelClient config={config} />
}
