import Image from "next/image"
import { ForgotPasswordForm } from "@/components/forgot-password-form"
import { KeyRound } from "lucide-react"

export default function ForgotPasswordPage() {
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
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Reset your password</h2>
            <p className="text-sm text-pretty text-muted-foreground">
              Enter your work email and we&apos;ll send you a link to reset your password.
            </p>
          </div>
        </div>
        <ForgotPasswordForm />
      </div>
    </main>
  )
}
