import "server-only"
import { cookies } from "next/headers"
import { SignJWT, jwtVerify } from "jose"
import { query } from "@/lib/db"

const COOKIE = "muenot_session"
const secretKey = process.env.SESSION_SECRET || "dev-insecure-secret-change-me"
const key = new TextEncoder().encode(secretKey)

export type SessionUser = {
  id: number
  name: string
  email: string
  role: "admin" | "employee"
}

export async function createSession(user: SessionUser) {
  const token = await new SignJWT({ user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key)

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  })
}

export async function destroySession() {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, key)
    return (payload as any).user as SessionUser
  } catch {
    return null
  }
}

// Verifies a login against the users table using bcrypt.
export async function verifyCredentials(email: string, password: string): Promise<SessionUser | null> {
  const bcrypt = await import("bcryptjs")
  const rows = await query<{
    id: number
    name: string
    email: string
    role: "admin" | "employee"
    password_hash: string
    is_active: number
  }>("SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = ? LIMIT 1", [email])
  const u = rows[0]
  if (!u || !u.is_active) return null
  const ok = await bcrypt.compare(password, u.password_hash)
  if (!ok) return null
  return { id: u.id, name: u.name, email: u.email, role: u.role }
}
