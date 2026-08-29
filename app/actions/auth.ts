"use server"

import { redirect } from "next/navigation"
import { createSession, destroySession, verifyCredentials } from "@/lib/auth"

export type LoginState = { error?: string }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") || "").trim().toLowerCase()
  const password = String(formData.get("password") || "")
  if (!email || !password) return { error: "Email and password are required." }

  let user
  try {
    user = await verifyCredentials(email, password)
  } catch (e: any) {
    return {
      error:
        "Could not reach the database. Make sure DATABASE_URL points to your MySQL and the schema has been created.",
    }
  }
  if (!user) return { error: "Invalid email or password." }

  await createSession(user)
  redirect("/")
}

export async function logoutAction() {
  await destroySession()
  redirect("/login")
}
