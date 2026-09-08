import Link from "next/link"
import Image from "next/image"

export function PublicHeader() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
        <Link href="/careers" className="flex items-center gap-2" aria-label="Muenot Careers home">
          <Image
            src="/muenot-logo.png"
            alt="Muenot — Infinite Learning, Endless Possibilities"
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
            className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
          >
            Jobs
          </Link>
        </nav>
      </div>
    </header>
  )
}

export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-muted-foreground md:px-6">
        © {new Date().getFullYear()} By Muenot · Powered by Muenot ERP
      </div>
    </footer>
  )
}
