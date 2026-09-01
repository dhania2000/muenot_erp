import Image from "next/image"
import Link from "next/link"
import { KeyRound, AlertTriangle } from "lucide-react"
import { ResetPasswordForm } from "@/components/reset-password-form"
import { verifyResetToken } from "@/lib/password-reset"

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  let result = null
  if (token) {
    try {
      result = await verifyResetToken(token)
    } catch (error) {
      console.error("[v0] reset-password token verification error:", error)
      result = null
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-start gap-3">
          <Image
            src="/muenot-logo-transparent.png"
            alt="Muenot"
            width={132}
            height={30}
            className="mb-4 h-6 w-auto object-contain"
            priority
          />
          {result ? (
            <>
              <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <KeyRound className="size-5" />
              </div>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-2xl font-semibold tracking-tight">Choose a new password</h2>
                <p className="text-sm text-muted-foreground">Your new password must be at least 8 characters.</p>
              </div>
            </>
          ) : (
            <>
              <div className="flex size-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <AlertTriangle className="size-5" />
              </div>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-2xl font-semibold tracking-tight">Link expired or invalid</h2>
                <p className="text-sm text-pretty text-muted-foreground">
                  This password reset link is no longer valid. Request a new one to continue.
                </p>
              </div>
            </>
          )}
        </div>

        {result ? (
          <ResetPasswordForm token={token as string} />
        ) : (
          <Link href="/forgot-password" className="text-sm font-medium text-primary">
            Request a new reset link
          </Link>
        )}
      </div>
    </main>
  )
}
