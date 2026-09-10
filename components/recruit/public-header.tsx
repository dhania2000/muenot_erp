import Link from "next/link"
import Image from "next/image"
import { getCareersContent } from "@/lib/careers-settings-server"

export async function PublicHeader() {
  const content = await getCareersContent()
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
        <Link href="/careers" className="flex items-center gap-2" aria-label={`${content.companyName} Careers home`}>
          <Image
            src={content.headerLogo || "/muenot-logo.png"}
            alt={content.tagline ? `${content.companyName} — ${content.tagline}` : content.companyName}
            width={200}
            height={48}
            priority
            className="h-9 w-auto md:h-10"
          />
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/careers" className="text-muted-foreground transition-colors hover:text-foreground">
            About
          </Link>
          <Link
            href="/job-opening"
            style={{ backgroundColor: content.accentColor }}
            className="inline-flex items-center rounded-md px-4 py-2 font-medium text-white transition-opacity hover:opacity-90"
          >
            Jobs
          </Link>
        </nav>
      </div>
    </header>
  )
}

export async function PublicFooter() {
  const content = await getCareersContent()
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-muted-foreground md:px-6">
        © {new Date().getFullYear()} {content.footerText}
      </div>
    </footer>
  )
}
