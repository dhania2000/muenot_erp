import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { ChangePasswordForm } from "@/components/change-password-form"
import { KeyRound } from "lucide-react"

export default async function ChangePasswordPage() {
  const session = await getSession()
  if (!session) redirect("/login")

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Set a new password</h2>
            <p className="text-sm text-muted-foreground">
              For security, please replace your temporary password before continuing.
            </p>
          </div>
        </div>
        <ChangePasswordForm role={session.role} />
      </div>
    </main>
  )
}
