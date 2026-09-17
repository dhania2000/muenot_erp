import type { Metadata } from "next"
import { SignClient } from "./sign-client"

export const metadata: Metadata = {
  title: "Sign Document — Muenot",
  description: "Review and sign your document securely.",
  robots: { index: false, follow: false },
}

export default async function EsignSignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <SignClient token={token} />
}
