import { Mail } from "lucide-react"
import { MarketingChannelClient, type ChannelConfig } from "@/components/marketing/marketing-channel-client"

const config: ChannelConfig = {
  key: "eml",
  title: "Email Campaigns",
  description: "Design, schedule, and measure email blasts, newsletters, and drip sequences.",
  icon: Mail,
  engagementLabel: "Open Rate",
  createLabel: "New Email Blast",
  reachLabel: "Recipients",
  seed: [
    { id: "EML-101", name: "Summer Product Launch", status: "Active", audience: 24500, sent: 24500, engagement: "42.1%" },
    { id: "EML-102", name: "Weekly Newsletter #34", status: "Completed", audience: 18200, sent: 18200, engagement: "38.7%" },
    { id: "EML-103", name: "Webinar Invite Series", status: "Scheduled", audience: 9800, sent: 0, engagement: "—" },
    { id: "EML-104", name: "Cart Abandonment Drip", status: "Active", audience: 3400, sent: 2900, engagement: "51.3%" },
    { id: "EML-105", name: "Re-engagement Winback", status: "Draft", audience: 6100, sent: 0, engagement: "—" },
  ],
}

export default function EmailCampaignsPage() {
  return <MarketingChannelClient config={config} />
}
