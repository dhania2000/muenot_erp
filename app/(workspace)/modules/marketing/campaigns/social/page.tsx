import { Share2 } from "lucide-react"
import { MarketingChannelClient, type ChannelConfig } from "@/components/marketing/marketing-channel-client"

const config: ChannelConfig = {
  key: "soc",
  title: "Social Campaigns",
  description: "Publish and track paid and organic posts across your connected social networks.",
  icon: Share2,
  engagementLabel: "Engagement Rate",
  createLabel: "New Social Post",
  reachLabel: "Reach",
  seed: [
    { id: "SOC-101", name: "Brand Awareness — LinkedIn", status: "Active", audience: 84000, sent: 62000, engagement: "4.8%" },
    { id: "SOC-102", name: "Product Teaser — Instagram", status: "Active", audience: 51000, sent: 51000, engagement: "6.2%" },
    { id: "SOC-103", name: "Founder AMA — X", status: "Scheduled", audience: 30000, sent: 0, engagement: "—" },
    { id: "SOC-104", name: "Customer Story — Facebook", status: "Completed", audience: 42000, sent: 42000, engagement: "3.1%" },
    { id: "SOC-105", name: "Hiring Push — LinkedIn", status: "Draft", audience: 20000, sent: 0, engagement: "—" },
  ],
}

export default function SocialCampaignsPage() {
  return <MarketingChannelClient config={config} />
}
