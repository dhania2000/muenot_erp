import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { createResetToken } from "@/lib/password-reset"
import { hydrateDepartmentSMTP, isEmailConfigured, resolveBaseUrl, sendEmail } from "@/lib/email"

type UserRow = { id: number; name: string; email: string; status: "active" | "inactive" }

export async function POST(request: Request) {
  try {
    const { email } = await request.json()
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 })
    }

    // Always return the same generic response whether or not the email
    // exists, so this endpoint can't be used to discover valid accounts.
    const genericResponse = NextResponse.json({
      ok: true,
      message: "If an account exists for that email, a password reset link has been sent.",
    })

    const rows = await query<UserRow[]>("SELECT id, name, email, status FROM users WHERE email = ? LIMIT 1", [
      String(email).toLowerCase().trim(),
    ])
    const user = rows[0]
    if (!user || user.status !== "active") {
      return genericResponse
    }

    const token = await createResetToken(user.id)

    await hydrateDepartmentSMTP("hr")
    if (isEmailConfigured("hr")) {
      const baseUrl = resolveBaseUrl(request)
      const resetLink = `${baseUrl}/reset-password?token=${token}`
      const html = `
        <p>Hi ${user.name},</p>
        <p>We received a request to reset your Muenot ERP password. Click the button below to choose a new one:</p>
        <p><a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#111827;color:#fff;border-radius:6px;text-decoration:none;">Reset your password</a></p>
        <p>Or copy this link into your browser: ${resetLink}</p>
        <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      `
      try {
        await sendEmail({ to: user.email, subject: "Reset your Muenot ERP password", html, department: "hr" })
      } catch (error) {
        console.error("[v0] forgot-password email send error:", error)
      }
    } else {
      console.warn("[v0] forgot-password: SMTP is not configured, reset email was not sent")
    }

    return genericResponse
  } catch (error) {
    console.error("[v0] forgot-password error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
