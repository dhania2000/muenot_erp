import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const domainPattern = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export async function POST(request: Request) {
  const session = await requireFeature("sales.get_email_name")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const firstName = String(body.firstName || "").trim().replace(/[^\p{L}\s'-]/gu, "")
  const middleName = String(body.middleName || "").trim().replace(/[^\p{L}\s'-]/gu, "")
  const lastName = String(body.lastName || "").trim().replace(/[^\p{L}\s'-]/gu, "")
  const domain = String(body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
  if (!firstName || !domainPattern.test(domain)) return NextResponse.json({ error: "First name and a valid company domain are required." }, { status: 400 })
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ")
  const query = encodeURIComponent(`"${fullName}" "@${domain}"`)
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; EmailFinder/1.0)" }, signal: AbortSignal.timeout(8000), cache: "no-store" }).catch(() => null)
  if (!response?.ok) return NextResponse.json({ results: [], message: "No public source could be reached. Try again later." })
  const html = await response.text()
  const emails = Array.from(new Set((html.match(emailPattern) || []).map(email => email.toLowerCase()).filter(email => email.endsWith(`@${domain}`))))
  const results = emails.slice(0, 10).map(email => ({ email, source: `https://html.duckduckgo.com/html/?q=${query}`, title: "Public web search result", confidence: "Possible" as const }))
  return NextResponse.json({ results })
}
