import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { getCompanySettings } from "@/lib/hr-letters-db"
import { getLetter, letterCompanyFromSettings, letterSignatoryFromSettings } from "@/lib/hr-letters-generate"
import { letterPdfBuffer } from "@/lib/hr-letter-pdf"

export const runtime = "nodejs"

// GET /api/hr/letters/:id/pdf[?download=1]
// Renders the STORED (already-merged) letter into the shared corporate PDF.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, "hr.view_letters"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const letter = await getLetter(Number(id))
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 })

  const settings = await getCompanySettings()
  const recipientMeta = [
    letter.employee_code,
    [letter.designation, letter.department].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(" · ")

  const pdf = letterPdfBuffer({
    letterNumber: letter.letter_number,
    referenceNo: letter.reference_no || null,
    subject: letter.subject,
    body: letter.body,
    issueDate: letter.issue_date,
    recipientName: letter.recipient_name || letter.employee_name || null,
    recipientMeta: recipientMeta || null,
    company: letterCompanyFromSettings(settings),
    signatory: letterSignatoryFromSettings(settings),
  })

  const safeName = (letter.recipient_name || letter.employee_name || "letter").replace(/[^a-z0-9]+/gi, "-")
  const fileName = `${letter.letter_number}-${safeName}.pdf`
  const disposition = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}
