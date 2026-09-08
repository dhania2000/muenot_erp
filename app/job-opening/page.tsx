import type { Metadata } from "next"
import { JobBrowserClient } from "@/components/recruit/job-browser-client"
import { PublicHeader, PublicFooter } from "@/components/recruit/public-header"

export const metadata: Metadata = {
  title: "Open Positions — Muenot Careers",
  description: "Browse open roles at Muenot and apply in minutes.",
}

export default function JobOpeningsPage() {
  return (
    <div className="light flex min-h-screen flex-col bg-muted text-foreground [color-scheme:light]">
      <PublicHeader />
      <main className="flex-1">
        <JobBrowserClient />
      </main>
      <PublicFooter />
    </div>
  )
}
