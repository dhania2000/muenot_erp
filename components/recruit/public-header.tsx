import Link from "next/link"
import { Building2 } from "lucide-react"

export function PublicHeader() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 md:px-6">
        <Link href="/careers" className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Building2 className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight">Muenot Careers</span>
        </Link>
        <Link href="/careers" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          All openings
        </Link>
      </div>
    </header>
  )
}

export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto max-w-5xl px-4 py-6 text-center text-xs text-muted-foreground md:px-6">
        Powered by Muenot ERP · Recruit
      </div>
    </footer>
  )
}
